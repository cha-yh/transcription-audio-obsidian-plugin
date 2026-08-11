export type ProgressStage =
  | "model-selected"
  | "file-detected"
  | "file-size"
  | "preparing-audio"
  | "speech-activity"
  | "target-file-selected"
  | "chunk-start"
  | "chunk-complete"
  | "chunk-short-response"
  | "chunk-failed"
  | "chunk-retry-requested"
  | "chunk-retry-complete"
  | "chunk-rerun-requested"
  | "chunk-rerun-complete"
  | "file-upload-start"
  | "file-upload-complete"
  | "api-request-start"
  | "api-request-retry"
  | "api-request-complete"
  | "api-usage"
  | "transcription-step-start"
  | "transcription-step-complete"
  | "temp-file-created"
  | "classification-step-start"
  | "classification-step-complete"
  | "classification-step-failed"
  | "classification-retry-requested"
  | "summarization-step-start"
  | "summarization-step-complete"
  | "summarization-step-failed"
  | "summarization-retry-requested"
  | "cancel-requested"
  | "cancelled"
  | "success"
  | "error";

/**
 * Attached to events that may be emitted either for a single whole-file
 * request (no chunk fields) or as part of a chunk (both fields set).
 */
type ChunkContext = { chunkIndex?: number; chunkTotal?: number };

export type ProgressEvent =
  | { stage: "model-selected"; model: string }
  | { stage: "file-detected"; fileName: string }
  | { stage: "file-size"; sizeBytes: number }
  | { stage: "preparing-audio"; message?: string }
  /** Voice-activity profile used to draw the sparkline in the detail log. */
  | {
      stage: "speech-activity";
      /** Speech-frame ratio per bucket across the whole recording, 0..1. */
      buckets: number[];
      totalMs: number;
      /** Every planned chunk in timeline order, skipped ones included. */
      chunks: {
        chunkIndex: number;
        startMs: number;
        endMs: number;
        speechRatio: number;
        /** Silence that will not be sent to the model. */
        skipped: boolean;
      }[];
    }
  | { stage: "target-file-selected"; path: string; line: number; ch: number }
  | {
      stage: "chunk-start";
      chunkIndex: number;
      chunkTotal: number;
      startMs: number;
      endMs: number;
    }
  | { stage: "chunk-complete"; chunkIndex: number; chunkTotal: number }
  | {
      stage: "chunk-short-response";
      chunkIndex: number;
      chunkTotal: number;
      charCount: number;
    }
  | {
      stage: "chunk-failed";
      chunkIndex: number;
      chunkTotal: number;
      message: string;
    }
  | { stage: "chunk-retry-requested"; chunkIndex: number }
  | {
      stage: "chunk-retry-complete";
      chunkIndex: number;
      chunkTotal: number;
      success: boolean;
    }
  /**
   * Re-run of a chunk that already succeeded, triggered from the Retry button.
   * Deliberately distinct from "chunk-retry-requested", which handleChunkRetries
   * listens for while the run is still waiting on failed chunks — the two must
   * not trigger each other.
   */
  | { stage: "chunk-rerun-requested"; chunkIndex: number }
  | {
      stage: "chunk-rerun-complete";
      chunkIndex: number;
      chunkTotal: number;
      success: boolean;
      message?: string;
      previousLength?: number;
      newLength?: number;
    }
  | ({ stage: "file-upload-start" } & ChunkContext)
  | ({ stage: "file-upload-complete"; elapsedMs: number } & ChunkContext)
  | ({ stage: "api-request-start" } & ChunkContext)
  | ({
      stage: "api-request-retry";
      attempt: number;
      message?: string;
    } & ChunkContext)
  | ({ stage: "api-request-complete"; elapsedMs: number } & ChunkContext)
  | ({
      stage: "api-usage";
      /**
       * Whether this chunk can be re-run from the log. Only the chunked
       * transcription path writes a marker-bearing file to replace into; the
       * inline WAV path builds its transcript in memory, so it opts out.
       */
      retryable?: boolean;
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      toolUsePromptTokenCount?: number;
      totalTokenCount?: number;
    } & ChunkContext)
  | { stage: "transcription-step-start" }
  | { stage: "transcription-step-complete"; elapsedMs: number }
  | { stage: "temp-file-created"; path: string }
  | { stage: "classification-step-start" }
  | { stage: "classification-step-complete"; elapsedMs: number; category: string }
  | { stage: "classification-step-failed"; message: string }
  | { stage: "classification-retry-requested" }
  | { stage: "summarization-step-start" }
  | { stage: "summarization-step-complete"; elapsedMs: number }
  | { stage: "summarization-step-failed"; message: string }
  | { stage: "summarization-retry-requested" }
  | { stage: "cancel-requested" }
  | { stage: "cancelled" }
  | { stage: "success" }
  | { stage: "error"; message: string };
