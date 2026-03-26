export type ProgressStage =
  | "model-selected"
  | "file-detected"
  | "file-size"
  | "preparing-audio"
  | "target-file-selected"
  | "chunk-start"
  | "chunk-complete"
  | "chunk-short-response"
  | "chunk-failed"
  | "chunk-retry-requested"
  | "chunk-retry-complete"
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

export type ProgressEvent =
  | { stage: "model-selected"; model: string }
  | { stage: "file-detected"; fileName: string }
  | { stage: "file-size"; sizeBytes: number }
  | { stage: "preparing-audio"; message?: string }
  | { stage: "target-file-selected"; path: string; line: number; ch: number }
  | { stage: "chunk-start"; chunkIndex: number; chunkTotal: number }
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
  | { stage: "file-upload-start" }
  | { stage: "file-upload-complete"; elapsedMs: number }
  | { stage: "api-request-start" }
  | { stage: "api-request-retry"; attempt: number; message?: string }
  | { stage: "api-request-complete"; elapsedMs: number }
  | {
      stage: "api-usage";
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      toolUsePromptTokenCount?: number;
      totalTokenCount?: number;
    }
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
