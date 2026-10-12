import type { ProgressEvent } from "_base/types/progress";
import type {
  PersistedChunkPhase,
  PersistedRunProgress,
  PersistedSparkline,
} from "_base/types/sessionHistory";

export type ChunkPhase = PersistedChunkPhase;

/**
 * What the progress area draws. Kept as a pure state machine over progress
 * events so the transitions can be tested without a DOM.
 */
export interface RunProgress {
  sparkline?: PersistedSparkline;
  chartUnavailable?: boolean;
  chunkPhases: Map<number, ChunkPhase>;
  /**
   * Phase a chunk had when its re-run was requested. A failed re-run leaves
   * the previous transcript in place, so a chunk that was done stays done.
   * Not persisted: re-runs never survive a reload.
   */
  rerunFrom: Map<number, ChunkPhase | undefined>;
  /**
   * Classification and summarization send the same chunk-less API events as a
   * whole-file transcription, so those count as chunk 1 only inside the
   * transcription step. Not persisted for the same reason as `rerunFrom`.
   */
  inTranscriptionStep: boolean;
}

const PHASES: ChunkPhase[] = [
  "starting",
  "uploading",
  "transcribing",
  "done",
  "failed",
];

export function createRunProgress(): RunProgress {
  return {
    chunkPhases: new Map(),
    rerunFrom: new Map(),
    inTranscriptionStep: false,
  };
}

export function isInFlight(phase: ChunkPhase | undefined): boolean {
  return (
    phase === "starting" || phase === "uploading" || phase === "transcribing"
  );
}

/**
 * Whole-file requests carry no chunk fields on their upload and API events.
 * They are numbered as chunk 1 everywhere else, so they are here too.
 */
function chunkOf(
  progress: RunProgress,
  e: { chunkIndex?: number }
): number | undefined {
  if (e.chunkIndex !== undefined) return e.chunkIndex;
  return progress.inTranscriptionStep ? 1 : undefined;
}

/** Applies one event. Returns whether anything the area draws changed. */
export function applyRunProgressEvent(
  progress: RunProgress,
  e: ProgressEvent
): boolean {
  const set = (chunkIndex: number | undefined, phase: ChunkPhase): boolean => {
    if (chunkIndex === undefined) return false;
    if (progress.chunkPhases.get(chunkIndex) === phase) return false;
    progress.chunkPhases.set(chunkIndex, phase);
    return true;
  };

  switch (e.stage) {
    case "transcription-step-start":
      progress.inTranscriptionStep = true;
      return false;
    case "transcription-step-complete":
      progress.inTranscriptionStep = false;
      return false;
    case "speech-activity":
      progress.sparkline = {
        buckets: e.buckets,
        totalMs: e.totalMs,
        chunks: e.chunks,
      };
      return true;
    case "audio-decode-unavailable":
      progress.chartUnavailable = true;
      return true;
    case "chunk-start":
      return set(e.chunkIndex, "starting");
    case "file-upload-start":
      return set(chunkOf(progress, e), "uploading");
    case "api-request-start":
    case "api-request-retry":
      return set(chunkOf(progress, e), "transcribing");
    case "api-request-complete":
    case "chunk-complete":
      return set(chunkOf(progress, e), "done");
    case "chunk-failed":
      return set(e.chunkIndex, "failed");
    case "chunk-rerun-requested":
      progress.rerunFrom.set(
        e.chunkIndex,
        progress.chunkPhases.get(e.chunkIndex)
      );
      return set(e.chunkIndex, "starting");
    case "chunk-rerun-complete": {
      const from = progress.rerunFrom.get(e.chunkIndex);
      progress.rerunFrom.delete(e.chunkIndex);
      if (e.success) return set(e.chunkIndex, "done");
      return set(e.chunkIndex, from === "done" ? "done" : "failed");
    }
    default:
      return false;
  }
}

export function toPersistedRunProgress(
  progress: RunProgress
): PersistedRunProgress {
  return {
    sparkline: progress.sparkline,
    chartUnavailable: progress.chartUnavailable,
    chunks: Array.from(progress.chunkPhases.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([chunkIndex, phase]) => ({ chunkIndex, phase })),
  };
}

export function fromPersistedRunProgress(
  persisted: PersistedRunProgress
): RunProgress {
  const progress = createRunProgress();
  progress.sparkline = persisted.sparkline;
  progress.chartUnavailable = persisted.chartUnavailable;
  for (const chunk of persisted.chunks) {
    progress.chunkPhases.set(chunk.chunkIndex, chunk.phase);
  }
  return progress;
}

export function asChunkPhase(value: unknown): ChunkPhase | undefined {
  return PHASES.indexOf(value as ChunkPhase) >= 0
    ? (value as ChunkPhase)
    : undefined;
}
