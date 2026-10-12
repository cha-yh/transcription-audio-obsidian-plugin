import type { ProgressEvent } from "_base/types/progress";
import type {
  PersistedStepPhase,
  PersistedSummaryProgress,
} from "_base/types/sessionHistory";

export type SummaryProgress = PersistedSummaryProgress;

const STEP_PHASES: PersistedStepPhase[] = ["running", "done", "failed"];

export function asStepPhase(value: unknown): PersistedStepPhase | undefined {
  return STEP_PHASES.indexOf(value as PersistedStepPhase) >= 0
    ? (value as PersistedStepPhase)
    : undefined;
}

/**
 * Folds one event into the summary state. Returns the same object when the
 * event does not concern it, so `next !== prev` means "redraw".
 */
export function reduceSummaryProgress(
  prev: SummaryProgress | undefined,
  e: ProgressEvent
): SummaryProgress | undefined {
  const state = prev ?? {};
  switch (e.stage) {
    case "classification-step-start":
      return { ...state, classify: { phase: "running" } };
    case "classification-step-complete":
      return { ...state, classify: { phase: "done", category: e.category } };
    case "classification-step-failed":
      return {
        ...state,
        classify: { ...state.classify, phase: "failed" },
      };
    case "summarization-step-start":
      return { ...state, phase: "running", prompt: e.prompt };
    case "summarization-step-complete":
      return { ...state, phase: "done" };
    case "summarization-step-failed":
      return { ...state, phase: "failed" };
    case "summary-file-created":
      return { ...state, path: e.path };
    default:
      return prev;
  }
}
