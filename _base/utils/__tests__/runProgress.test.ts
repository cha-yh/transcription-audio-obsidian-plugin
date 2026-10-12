import { describe, it, expect } from "vitest";
import {
  applyRunProgressEvent,
  createRunProgress,
  fromPersistedRunProgress,
  isInFlight,
  toPersistedRunProgress,
  type RunProgress,
} from "../runProgress";
import type { ProgressEvent } from "_base/types/progress";

function run(events: ProgressEvent[], progress = createRunProgress()): RunProgress {
  for (const e of events) applyRunProgressEvent(progress, e);
  return progress;
}

const chunked = { chunkTotal: 2 };

describe("applyRunProgressEvent", () => {
  it("holds the chart from speech analysis", () => {
    const progress = run([
      {
        stage: "speech-activity",
        buckets: [0.1, 0.9],
        totalMs: 60000,
        chunks: [
          { chunkIndex: 1, startMs: 0, endMs: 60000, speechRatio: 0.5, skipped: false },
        ],
      },
    ]);
    expect(progress.sparkline?.buckets).toEqual([0.1, 0.9]);
    expect(progress.sparkline?.totalMs).toBe(60000);
  });

  it("marks the chart unavailable when the audio cannot be decoded", () => {
    const progress = run([
      { stage: "audio-decode-unavailable", message: "unsupported" },
    ]);
    expect(progress.chartUnavailable).toBe(true);
  });

  it("walks a chunk through upload, transcription and completion", () => {
    const progress = createRunProgress();
    const phases: (string | undefined)[] = [];
    const events: ProgressEvent[] = [
      { stage: "chunk-start", chunkIndex: 2, startMs: 0, endMs: 1, ...chunked },
      { stage: "file-upload-start", chunkIndex: 2, ...chunked },
      { stage: "api-request-start", chunkIndex: 2, ...chunked },
      { stage: "chunk-complete", chunkIndex: 2, ...chunked },
    ];
    for (const e of events) {
      applyRunProgressEvent(progress, e);
      phases.push(progress.chunkPhases.get(2));
    }
    expect(phases).toEqual(["starting", "uploading", "transcribing", "done"]);
  });

  it("keeps chunks apart when they run in parallel", () => {
    const progress = run([
      { stage: "file-upload-start", chunkIndex: 1, ...chunked },
      { stage: "api-request-start", chunkIndex: 2, ...chunked },
      { stage: "chunk-failed", chunkIndex: 1, message: "boom", ...chunked },
    ]);
    expect(progress.chunkPhases.get(1)).toBe("failed");
    expect(progress.chunkPhases.get(2)).toBe("transcribing");
  });

  it("counts chunk-less events as chunk 1 inside the transcription step", () => {
    const progress = run([
      { stage: "transcription-step-start" },
      { stage: "file-upload-start" },
    ]);
    expect(progress.chunkPhases.get(1)).toBe("uploading");

    run([{ stage: "api-request-complete", elapsedMs: 10 }], progress);
    expect(progress.chunkPhases.get(1)).toBe("done");
  });

  it("ignores classification and summary requests after transcription", () => {
    const progress = run([
      { stage: "transcription-step-start" },
      { stage: "chunk-failed", chunkIndex: 1, chunkTotal: 1, message: "empty" },
      { stage: "transcription-step-complete", elapsedMs: 10 },
      { stage: "api-request-start" },
      { stage: "api-request-complete", elapsedMs: 10 },
    ]);
    expect(progress.chunkPhases.get(1)).toBe("failed");
  });

  it("does not track chunk-less events before transcription starts", () => {
    const changed = applyRunProgressEvent(createRunProgress(), {
      stage: "api-request-start",
    });
    expect(changed).toBe(false);
  });

  it("recovers a failed chunk through a re-run", () => {
    const progress = run([
      { stage: "chunk-failed", chunkIndex: 1, message: "boom", ...chunked },
      { stage: "chunk-rerun-requested", chunkIndex: 1 },
    ]);
    expect(progress.chunkPhases.get(1)).toBe("starting");

    run([{ stage: "chunk-rerun-complete", chunkIndex: 1, success: true, ...chunked }], progress);
    expect(progress.chunkPhases.get(1)).toBe("done");
  });

  it("keeps a done chunk done when its re-run fails", () => {
    // The transcript is only rewritten on success, so the old text stands.
    const progress = run([
      { stage: "chunk-complete", chunkIndex: 1, ...chunked },
      { stage: "chunk-rerun-requested", chunkIndex: 1 },
      {
        stage: "chunk-rerun-complete",
        chunkIndex: 1,
        success: false,
        message: "quota",
        ...chunked,
      },
    ]);
    expect(progress.chunkPhases.get(1)).toBe("done");
  });

  it("marks a skipped range failed when transcribing it fails", () => {
    const progress = run([
      { stage: "chunk-rerun-requested", chunkIndex: 3 },
      {
        stage: "chunk-rerun-complete",
        chunkIndex: 3,
        success: false,
        ...chunked,
      },
    ]);
    expect(progress.chunkPhases.get(3)).toBe("failed");
  });

  it("reports no change for events it does not draw", () => {
    expect(
      applyRunProgressEvent(createRunProgress(), { stage: "success" })
    ).toBe(false);
  });
});

describe("isInFlight", () => {
  it("is true only while a chunk is being worked on", () => {
    expect(isInFlight("starting")).toBe(true);
    expect(isInFlight("uploading")).toBe(true);
    expect(isInFlight("transcribing")).toBe(true);
    expect(isInFlight("done")).toBe(false);
    expect(isInFlight("failed")).toBe(false);
    expect(isInFlight(undefined)).toBe(false);
  });
});

describe("persisted run progress", () => {
  it("round-trips chunk phases in ascending order", () => {
    const progress = run([
      { stage: "chunk-complete", chunkIndex: 2, ...chunked },
      { stage: "chunk-failed", chunkIndex: 1, message: "x", ...chunked },
    ]);
    const persisted = toPersistedRunProgress(progress);
    expect(persisted.chunks).toEqual([
      { chunkIndex: 1, phase: "failed" },
      { chunkIndex: 2, phase: "done" },
    ]);

    const restored = fromPersistedRunProgress(persisted);
    expect(restored.chunkPhases.get(1)).toBe("failed");
    expect(restored.chunkPhases.get(2)).toBe("done");
    expect(restored.inTranscriptionStep).toBe(false);
  });
});
