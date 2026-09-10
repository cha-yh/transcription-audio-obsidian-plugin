import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProgressHistoryStore,
  type SessionHistoryPort,
} from "../ProgressHistoryStore";
import { createInitialSession } from "_base/utils/sessionSnapshot";
import type { PersistedSession } from "_base/types/sessionHistory";
import { progressHistoryV1 } from "../../../../tests/fixtures/progressHistoryV1";

function createPort(read: string | null = null): SessionHistoryPort & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  backup: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue(read),
    write: vi.fn().mockResolvedValue(undefined),
    backup: vi.fn().mockResolvedValue(undefined),
  };
}

function finished(id: string, startedAtMs: number): PersistedSession {
  return {
    ...createInitialSession(startedAtMs, 0),
    id,
    status: "success",
    statusText: "Success",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hydrate", () => {
  it("returns an empty list when no file exists", async () => {
    const port = createPort(null);
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });

    await store.hydrate();
    expect(store.list()).toEqual([]);
  });

  it("restores stored sessions", async () => {
    const store = new ProgressHistoryStore(
      createPort(JSON.stringify(progressHistoryV1)),
      { enabled: true, limit: 20 }
    );

    await store.hydrate();
    expect(store.list().map((s) => s.id)).toEqual(["m2x1k0-1", "m2x0zz-0"]);
  });

  it("demotes a run that was still going", async () => {
    const running = createInitialSession(1757480652000, 0);
    const store = new ProgressHistoryStore(
      createPort(JSON.stringify({ version: 1, sessions: [running] })),
      { enabled: true, limit: 20 }
    );

    await store.hydrate();
    expect(store.list()[0].status).toBe("interrupted");
  });

  it("applies the retention limit on load", async () => {
    const store = new ProgressHistoryStore(
      createPort(JSON.stringify(progressHistoryV1)),
      { enabled: true, limit: 1 }
    );

    await store.hydrate();
    expect(store.list()).toHaveLength(1);
  });

  it("backs up a file written by a newer version instead of reading it", async () => {
    const port = createPort(JSON.stringify({ version: 99, sessions: [] }));
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 20 });

    await store.hydrate();
    expect(port.backup).toHaveBeenCalledWith("v99");
    expect(store.list()).toEqual([]);
  });

  it("skips the file entirely when history is off", async () => {
    const port = createPort(JSON.stringify(progressHistoryV1));
    const store = new ProgressHistoryStore(port, {
      enabled: false,
      limit: 20,
    });

    await store.hydrate();
    expect(port.read).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("survives a corrupt file without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new ProgressHistoryStore(createPort("{ not json"), {
      enabled: true,
      limit: 20,
    });

    await store.hydrate();
    expect(store.list()).toEqual([]);
  });
});

describe("saving", () => {
  it("collapses scheduled saves into one write", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    store.setSource(() => [finished("a", 1)]);

    store.schedule();
    store.schedule();
    store.schedule();
    expect(port.write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(port.write).toHaveBeenCalledTimes(1);
  });

  it("writes immediately on flush and cancels the pending timer", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    store.setSource(() => [finished("a", 1)]);

    store.schedule();
    await store.flush();
    expect(port.write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(port.write).toHaveBeenCalledTimes(1);
  });

  it("takes the snapshot at write time, not at schedule time", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    let sessions = [finished("a", 1)];
    store.setSource(() => sessions);

    store.schedule();
    sessions = [finished("b", 2), finished("a", 1)];
    await store.flush();

    const written = JSON.parse(port.write.mock.calls[0][0] as string);
    expect(written.sessions.map((s: PersistedSession) => s.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("serializes overlapping writes instead of interleaving them", async () => {
    const order: string[] = [];
    const port = createPort();
    port.write.mockImplementation(async (data: string) => {
      const { sessions } = JSON.parse(data);
      order.push(`start:${sessions[0].id}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push(`end:${sessions[0].id}`);
    });

    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    let sessions = [finished("first", 1)];
    store.setSource(() => sessions);

    const firstWrite = store.flush();
    sessions = [finished("second", 2)];
    const secondWrite = store.flush();

    await vi.runAllTimersAsync();
    await Promise.all([firstWrite, secondWrite]);

    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("keeps saving after a failed write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = createPort();
    port.write.mockRejectedValueOnce(new Error("disk full"));

    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    store.setSource(() => [finished("a", 1)]);

    await expect(store.flush()).resolves.toBeUndefined();
    await store.flush();
    expect(port.write).toHaveBeenCalledTimes(2);
  });

  it("writes nothing while history is off", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: false,
      limit: 20,
    });
    store.setSource(() => [finished("a", 1)]);

    store.schedule();
    await store.flush();
    await vi.runAllTimersAsync();
    expect(port.write).not.toHaveBeenCalled();
  });

  it("stops writing once history is switched off, leaving the file alone", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    store.setSource(() => [finished("a", 1)]);

    store.schedule();
    store.setOptions({ enabled: false, limit: 20 });
    await vi.runAllTimersAsync();
    expect(port.write).not.toHaveBeenCalled();
  });

  it("applies the retention limit to what it writes", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 2 });
    store.setSource(() => [
      finished("c", 3),
      finished("b", 2),
      finished("a", 1),
    ]);

    await store.flush();
    const written = JSON.parse(port.write.mock.calls[0][0] as string);
    expect(written.sessions.map((s: PersistedSession) => s.id)).toEqual([
      "c",
      "b",
    ]);
  });

  it("drops oldest-first when the file would exceed the byte cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: undefined,
    });

    const bulky = (id: string, startedAtMs: number): PersistedSession => ({
      ...finished(id, startedAtMs),
      logHistory: Array.from({ length: 300 }, () => ({
        text: "x".repeat(4000),
      })),
    });
    store.setSource(() => [bulky("new", 2), bulky("old", 1)]);

    await store.flush();
    const written = JSON.parse(port.write.mock.calls[0][0] as string);
    expect(written.sessions.map((s: PersistedSession) => s.id)).toEqual([
      "new",
    ]);
  });

  it("kills every re-run affordance on the records it restores", async () => {
    const live = {
      ...finished("a", 1),
      status: "running" as const,
      rerunDisabled: false,
      logHistory: [{ text: "1/2 - Chunk failed", retryChunkIndex: 1 }],
    };
    const store = new ProgressHistoryStore(
      createPort(JSON.stringify({ version: 1, sessions: [live] })),
      { enabled: true, limit: 20 }
    );

    await store.hydrate();
    expect(store.list()[0].rerunDisabled).toBe(true);
    expect(store.list()[0].logHistory[0].retryStale).toBe(true);
  });

  it("backs up a file it cannot parse rather than overwriting it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = createPort("{ not json");
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 20 });

    await store.hydrate();
    expect(port.backup).toHaveBeenCalledWith("unreadable");
  });

  it("backs up a file whose records all fail to parse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = createPort(
      JSON.stringify({ version: 1, sessions: [{ nonsense: true }] })
    );
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 20 });

    await store.hydrate();
    expect(port.backup).toHaveBeenCalledWith("unreadable");
  });

  it("ignores a clearSource from a panel that no longer owns the source", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 20 });

    const closing = () => [finished("old", 1)];
    store.setSource(closing);
    const opening = () => [finished("new", 2)];
    store.setSource(opening);

    // The closing panel detaches after the new one attached; it must not
    // detach the source the surviving panel installed.
    store.clearSource(closing);
    await store.flush();

    const written = JSON.parse(port.write.mock.calls[0][0] as string);
    expect(written.sessions[0].id).toBe("new");
  });

  it("keeps what it wrote, so list() matches the file", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, { enabled: true, limit: 2 });
    store.setSource(() => [
      finished("c", 3),
      finished("b", 2),
      finished("a", 1),
    ]);

    await store.flush();
    expect(store.list().map((s) => s.id)).toEqual(["c", "b"]);
  });

  it("measures the byte cap in UTF-8, not string length", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: undefined,
    });

    // Each character is 3 UTF-8 bytes. One session fits, two do not - but by
    // string length both would, which is exactly the miscount being guarded.
    const korean = (id: string, startedAtMs: number): PersistedSession => ({
      ...finished(id, startedAtMs),
      logHistory: Array.from({ length: 300 }, () => ({
        text: "가".repeat(1300),
      })),
    });
    store.setSource(() => [korean("new", 2), korean("old", 1)]);

    await store.flush();
    const data = port.write.mock.calls[0][0] as string;
    expect(data.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(
      2 * 1024 * 1024
    );
    expect(JSON.parse(data).sessions.map((s: PersistedSession) => s.id)).toEqual(
      ["new"]
    );
  });

  it("reads the file again when history is switched back on", async () => {
    const port = createPort(JSON.stringify(progressHistoryV1));
    const store = new ProgressHistoryStore(port, {
      enabled: false,
      limit: 20,
    });

    await store.hydrate();
    expect(store.list()).toEqual([]);

    // Turning it back on must recover the file that was left alone, or the
    // next write would overwrite records the user was told were kept.
    store.setOptions({ enabled: true, limit: 20 });
    await store.hydrate();
    expect(store.list()).toHaveLength(2);
  });

  it("keeps the last list after the view detaches", async () => {
    const port = createPort();
    const store = new ProgressHistoryStore(port, {
      enabled: true,
      limit: 20,
    });
    const source = () => [finished("a", 1)];
    store.setSource(source);

    store.clearSource(source);
    await store.flush();

    const written = JSON.parse(port.write.mock.calls[0][0] as string);
    expect(written.sessions).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });
});
