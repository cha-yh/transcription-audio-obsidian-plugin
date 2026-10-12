import { describe, it, expect } from "vitest";
import { reduceSummaryProgress, type SummaryProgress } from "../summaryProgress";
import type { ProgressEvent } from "_base/types/progress";

function run(events: ProgressEvent[], start?: SummaryProgress) {
  return events.reduce<SummaryProgress | undefined>(
    (state, e) => reduceSummaryProgress(state, e),
    start
  );
}

describe("reduceSummaryProgress", () => {
  it("tracks classification through to its category", () => {
    const state = run([
      { stage: "classification-step-start" },
      { stage: "classification-step-complete", elapsedMs: 5, category: "Meeting" },
    ]);
    expect(state?.classify).toEqual({ phase: "done", category: "Meeting" });
  });

  it("keeps the prompt that was sent and the file that was written", () => {
    const state = run([
      { stage: "summarization-step-start", prompt: "Summarize briefly" },
      { stage: "summarization-step-complete", elapsedMs: 5 },
      { stage: "summary-file-created", path: "_summary_a.md" },
    ]);
    expect(state).toEqual({
      phase: "done",
      prompt: "Summarize briefly",
      path: "_summary_a.md",
    });
  });

  it("marks a failed step and keeps what came before", () => {
    const state = run([
      { stage: "classification-step-start" },
      { stage: "classification-step-failed", message: "boom" },
      { stage: "summarization-step-start", prompt: "p" },
      { stage: "summarization-step-failed", message: "boom" },
    ]);
    expect(state?.classify?.phase).toBe("failed");
    expect(state?.phase).toBe("failed");
    expect(state?.prompt).toBe("p");
  });

  it("replaces the prompt when a summary is requested again", () => {
    const state = run(
      [{ stage: "summarization-step-start", prompt: "new prompt" }],
      { phase: "done", prompt: "old prompt", path: "_summary_a.md" }
    );
    expect(state).toEqual({
      phase: "running",
      prompt: "new prompt",
      path: "_summary_a.md",
    });
  });

  it("returns the same object for events it does not track", () => {
    const state: SummaryProgress = { phase: "done" };
    expect(reduceSummaryProgress(state, { stage: "success" })).toBe(state);
    expect(reduceSummaryProgress(undefined, { stage: "success" })).toBe(
      undefined
    );
  });
});
