/**
 * What a progress-panel run looks like once it is written to disk.
 *
 * Everything here is a value the panel can render without re-deriving it: text
 * fields hold the already-formatted string rather than the number behind it.
 * That is deliberate — a stored sentence survives any change to the event
 * schema that produced it, so only the genuinely structured fields (chunk
 * counters, the sparkline, the status enum) ever need migrating.
 */

export type SessionStatus =
  | "running"
  | "interrupted"
  | "success"
  | "error"
  | "cancelled";

export interface PersistedSparklineChunk {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  speechRatio: number;
  skipped: boolean;
}

export interface PersistedSparkline {
  /** Speech-frame ratio per bucket, 0..1. */
  buckets: number[];
  totalMs: number;
  chunks: PersistedSparklineChunk[];
}

/**
 * Where one chunk stands. A chunk with no entry has not started yet, or was
 * skipped as silence if the sparkline says so.
 */
export type PersistedChunkPhase =
  | "starting"
  | "uploading"
  | "transcribing"
  | "done"
  | "failed";

/** The progress area under the status row: chart plus per-chunk state. */
export interface PersistedRunProgress {
  /** Undefined until speech analysis lands, which the chart shows as a skeleton. */
  sparkline?: PersistedSparkline;
  /** The audio could not be decoded here, so no chart will ever arrive. */
  chartUnavailable?: boolean;
  /** Ascending by chunk index. */
  chunks: { chunkIndex: number; phase: PersistedChunkPhase }[];
}

export interface PersistedLogEntry {
  text: string;
  /** When the line was logged. Absent on lines written before it was kept. */
  atMs?: number;
  /** Present when the line described a chunk result that could be re-run. */
  retryChunkIndex?: number;
  /** A newer result superseded this one, so its Retry button is dead. */
  retryStale?: boolean;
  sparkline?: PersistedSparkline;
}

/** Only present once a run has actually reported a chunk. */
export interface PersistedChunkProgress {
  total: number;
  index: number;
  completed: number;
  barMax: number;
  barValue: number;
  labelText: string;
}

export interface PersistedSession {
  id: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: SessionStatus;
  /** Status row text, e.g. "Success" / "Transcribing chunk" / "Interrupted". */
  statusText: string;
  /** The one-line summary above the detail log. */
  latestLogText: string;
  /** `formatBytes` output, kept as text so the unit choice is preserved. */
  fileSizeText: string;
  modelText: string;
  /** Cancel button label: "cancel" | "cancelling..." | "done" | "failed" | … */
  cancelLabel: string;
  /** Undefined hides the category row entirely. */
  categoryText?: string;
  /** Undefined hides the transcript row entirely. */
  transcriptPath?: string;
  audioPath?: string;
  audioName?: string;
  targetPath?: string;
  targetLine?: number;
  targetCh?: number;
  isCancellable: boolean;
  isLogExpanded: boolean;
  /**
   * Set once the controller no longer holds the context needed to re-run this
   * run's chunks — after a reload, or once a newer run replaced it. Every
   * re-run affordance on the card is dead from then on.
   */
  rerunDisabled?: boolean;
  chunk?: PersistedChunkProgress;
  /**
   * Absent on records written before the progress area existed; those keep
   * their chart in the log entry that carried it.
   */
  progress?: PersistedRunProgress;
  logHistory: PersistedLogEntry[];
  /** A Set at runtime; an ascending array on disk. */
  failedChunks: number[];
}

export interface SessionHistoryDoc {
  version: number;
  sessions: PersistedSession[];
}
