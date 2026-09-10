import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clampHistoryLimit,
  isRemovableStatus,
  createInitialSession,
  createSessionId,
  demoteRunning,
  fromSnapshot,
  MIGRATIONS,
  parseSessionHistory,
  pruneSessions,
  resolveHistoryLimit,
  roundBuckets,
  toSnapshot,
  trimLogHistory,
  type SessionRuntimeState,
} from "../sessionSnapshot";
import type { PersistedSession } from "_base/types/sessionHistory";
import { progressHistoryV1 } from "../../../tests/fixtures/progressHistoryV1";

function runtimeState(
  overrides: Partial<SessionRuntimeState> = {}
): SessionRuntimeState {
  return {
    ...fromSnapshot(createInitialSession(1757480652000, 1)),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isRemovableStatus", () => {
  it("refuses to remove a run that is still going", () => {
    expect(isRemovableStatus("running")).toBe(false);
  });

  it("allows removing a run that has stopped", () => {
    expect(isRemovableStatus("success")).toBe(true);
    expect(isRemovableStatus("error")).toBe(true);
    expect(isRemovableStatus("cancelled")).toBe(true);
    expect(isRemovableStatus("interrupted")).toBe(true);
  });
});

describe("createSessionId", () => {
  it("is stable for the same start time and sequence", () => {
    expect(createSessionId(1757480652000, 3)).toBe(
      createSessionId(1757480652000, 3)
    );
  });

  it("differs when two runs start in the same millisecond", () => {
    expect(createSessionId(1757480652000, 1)).not.toBe(
      createSessionId(1757480652000, 2)
    );
  });
});

describe("createInitialSession", () => {
  it("starts as a running session with a timestamped first log line", () => {
    const session = createInitialSession(1757480652000, 0);
    expect(session.status).toBe("running");
    expect(session.isCancellable).toBe(true);
    expect(session.logHistory).toHaveLength(1);
    expect(session.logHistory[0].text).toContain("Log start: ");
  });
});

describe("toSnapshot", () => {
  it("turns the runtime Sets into ascending arrays", () => {
    const snapshot = toSnapshot(
      runtimeState({ failedChunks: new Set([3, 1, 2]) })
    );
    expect(snapshot.failedChunks).toEqual([1, 2, 3]);
  });

  it("drops runtime-only retry flags", () => {
    const snapshot = toSnapshot(
      runtimeState({
        logHistory: [
          {
            text: "1/2 - Chunk failed",
            retryChunkIndex: 1,
            retryStale: true,
            retryRunning: true,
          },
        ],
        pendingRetryChunks: new Set([1]),
      })
    );
    expect(snapshot.logHistory[0]).toEqual({
      text: "1/2 - Chunk failed",
      retryChunkIndex: 1,
      sparkline: undefined,
    });
    expect(snapshot).not.toHaveProperty("pendingRetryChunks");
  });

  it("survives a JSON round trip unchanged", () => {
    const snapshot = toSnapshot(
      runtimeState({ failedChunks: new Set([2]), statusText: "Success" })
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(
      JSON.parse(JSON.stringify(snapshot))
    );
    expect(parseSessionHistory({ version: 1, sessions: [snapshot] }).sessions[0]
      .statusText).toBe("Success");
  });

  it("never writes anything that looks like an API key", () => {
    // The controller's rerun context holds one; this is the regression guard
    // that keeps it from reaching a file if the types are ever widened.
    const serialized = JSON.stringify(
      toSnapshot(runtimeState({ modelText: "gemini-3.7-flash" }))
    );
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("AIza");
  });
});

describe("fromSnapshot", () => {
  it("restores every retry button as stale", () => {
    const state = fromSnapshot({
      ...(progressHistoryV1.sessions[0] as PersistedSession),
    });
    const retryEntries = state.logHistory.filter(
      (entry) => entry.retryChunkIndex !== undefined
    );
    expect(retryEntries.length).toBeGreaterThan(0);
    expect(retryEntries.every((entry) => entry.retryStale)).toBe(true);
    expect(retryEntries.every((entry) => entry.retryRunning === false)).toBe(
      true
    );
  });

  it("rebuilds the Sets", () => {
    const state = fromSnapshot(
      progressHistoryV1.sessions[1] as PersistedSession
    );
    expect(state.failedChunks.has(1)).toBe(true);
    expect(state.pendingRetryChunks.size).toBe(0);
  });
});

describe("parseSessionHistory", () => {
  it("returns an empty history for missing or non-object input", () => {
    expect(parseSessionHistory(undefined).sessions).toEqual([]);
    expect(parseSessionHistory("nonsense").sessions).toEqual([]);
    expect(parseSessionHistory([]).sessions).toEqual([]);
  });

  it("reads the v1 golden fixture without losing anything", () => {
    const { sessions, futureVersion } = parseSessionHistory(progressHistoryV1);
    expect(futureVersion).toBeUndefined();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].transcriptPath).toBe("Recordings/standup.md");
    expect(sessions[0].chunk?.labelText).toBe("3/3 done");
    expect(sessions[0].logHistory[2].sparkline?.chunks).toHaveLength(2);
    expect(sessions[1].failedChunks).toEqual([2, 1]);
  });

  it("keeps the healthy sessions when one is damaged", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sessions } = parseSessionHistory({
      version: 1,
      sessions: [
        progressHistoryV1.sessions[0],
        { id: "broken", startedAtMs: 1, logHistory: "not an array" },
        progressHistoryV1.sessions[1],
      ],
    });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.id)).toEqual([
      "m2x1k0-1",
      "m2x0zz-0",
    ]);
  });

  it("drops log entries without text but keeps the session", () => {
    const { sessions } = parseSessionHistory({
      version: 1,
      sessions: [
        {
          ...progressHistoryV1.sessions[1],
          logHistory: [{ text: "kept" }, { retryChunkIndex: 4 }, null],
        },
      ],
    });
    expect(sessions[0].logHistory).toEqual([{ text: "kept" }]);
  });

  it("degrades an unknown status to interrupted instead of dropping the run", () => {
    const { sessions } = parseSessionHistory({
      version: 1,
      sessions: [{ ...progressHistoryV1.sessions[1], status: "paused" }],
    });
    expect(sessions[0].status).toBe("interrupted");
  });

  it("reports a future version and reads nothing from it", () => {
    const parsed = parseSessionHistory({
      version: 99,
      sessions: [progressHistoryV1.sessions[0]],
    });
    expect(parsed.futureVersion).toBe(99);
    expect(parsed.sessions).toEqual([]);
  });

  it("discards a version older than the supported floor", () => {
    expect(parseSessionHistory({ version: 0, sessions: [] }).sessions).toEqual(
      []
    );
  });

  it("runs migration steps in order", () => {
    const calls: number[] = [];
    MIGRATIONS[1] = (doc) => {
      calls.push(1);
      return doc;
    };
    MIGRATIONS[2] = (doc) => {
      calls.push(2);
      return doc;
    };
    try {
      // The chain only runs up to CURRENT_VERSION, which is 1 today, so a
      // stored v1 needs no step at all.
      parseSessionHistory({ version: 1, sessions: [] });
      expect(calls).toEqual([]);
    } finally {
      delete MIGRATIONS[1];
      delete MIGRATIONS[2];
    }
  });
});

describe("pruneSessions", () => {
  it("keeps the newest N", () => {
    expect(pruneSessions([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });

  it("keeps everything when auto-removal is off", () => {
    expect(pruneSessions([1, 2, 3], undefined)).toEqual([1, 2, 3]);
  });

  it("never empties the list, so a live run survives any limit", () => {
    expect(pruneSessions([1, 2, 3], 0)).toEqual([1]);
  });
});

describe("resolveHistoryLimit", () => {
  it("is undefined when auto-removal is off", () => {
    expect(
      resolveHistoryLimit({
        enableSessionHistory: true,
        autoPruneSessionHistory: false,
        sessionHistoryLimit: 20,
      })
    ).toBeUndefined();
  });

  it("floors at one so the running session is protected", () => {
    expect(
      resolveHistoryLimit({
        enableSessionHistory: true,
        autoPruneSessionHistory: true,
        sessionHistoryLimit: 0,
      })
    ).toBe(1);
  });
});

describe("clampHistoryLimit", () => {
  it("clamps to the supported range", () => {
    expect(clampHistoryLimit("0")).toBe(1);
    expect(clampHistoryLimit("9999")).toBe(200);
    expect(clampHistoryLimit("20")).toBe(20);
  });

  it("holds the boundaries", () => {
    expect(clampHistoryLimit("1")).toBe(1);
    expect(clampHistoryLimit("200")).toBe(200);
    expect(clampHistoryLimit("201")).toBe(200);
    expect(clampHistoryLimit("-5")).toBe(1);
  });

  it("truncates a fractional entry", () => {
    expect(clampHistoryLimit("20.7")).toBe(20);
  });

  it("returns undefined while the field is empty or nonsense", () => {
    expect(clampHistoryLimit("")).toBeUndefined();
    expect(clampHistoryLimit("abc")).toBeUndefined();
  });
});

describe("demoteRunning", () => {
  it("marks a run that never finished as interrupted", () => {
    const [session] = demoteRunning([createInitialSession(1, 0)]);
    expect(session.status).toBe("interrupted");
    expect(session.statusText).toBe("Interrupted");
    expect(session.isCancellable).toBe(false);
    expect(session.cancelLabel).toBe("stopped");
  });

  it("leaves finished runs alone", () => {
    const finished = progressHistoryV1.sessions[0] as PersistedSession;
    expect(demoteRunning([finished])[0]).toEqual(finished);
  });
});

describe("trimLogHistory", () => {
  it("leaves a short log untouched", () => {
    const entries = [{ text: "a" }, { text: "b" }];
    expect(trimLogHistory(entries, 5)).toBe(entries);
  });

  it("drops the oldest lines and says how many", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ text: `${i}` }));
    const trimmed = trimLogHistory(entries, 4);
    expect(trimmed).toHaveLength(4);
    expect(trimmed[0].text).toBe("... 7 earlier log lines trimmed");
    expect(trimmed[3].text).toBe("9");
  });
});

describe("roundBuckets", () => {
  it("cuts stored precision to three decimals", () => {
    expect(roundBuckets([0.123456, 1, 0])).toEqual([0.123, 1, 0]);
  });
});
