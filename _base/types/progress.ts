export type ProgressStage =
  | "file-detected"
  | "file-size"
  | "preparing-audio"
  | "target-file-selected"
  | "chunk-start"
  | "chunk-complete"
  | "chunk-failed"
  | "api-request-start"
  | "api-request-retry"
  | "api-request-complete"
  | "success"
  | "error";

export type ProgressEvent =
  | { stage: "file-detected"; fileName: string }
  | { stage: "file-size"; sizeBytes: number }
  | { stage: "preparing-audio"; message?: string }
  | { stage: "target-file-selected"; path: string; line: number; ch: number }
  | { stage: "chunk-start"; chunkIndex: number; chunkTotal: number }
  | { stage: "chunk-complete"; chunkIndex: number; chunkTotal: number }
  | {
      stage: "chunk-failed";
      chunkIndex: number;
      chunkTotal: number;
      message: string;
    }
  | { stage: "api-request-start" }
  | { stage: "api-request-retry"; attempt: number; message?: string }
  | { stage: "api-request-complete"; elapsedMs: number }
  | { stage: "success" }
  | { stage: "error"; message: string };
