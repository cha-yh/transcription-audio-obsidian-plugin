import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const RESUMABLE_UPLOAD_ENDPOINT =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export interface TranscriptionUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

export interface TranscriptionResult {
  text: string;
  usage: TranscriptionUsage;
  uploadedFile?: UploadedFileInfo;
}

export interface UploadedFileInfo {
  uri: string;
  mimeType: string;
  expirationTime?: string;
}

export class TranscriptionCancelledError extends Error {
  constructor() {
    super("Transcription was cancelled by user.");
    this.name = "TranscriptionCancelledError";
  }
}

export class TranscriptionQuotaError extends Error {
  status: string;
  detail: string;

  constructor(status: string, message: string) {
    super(status);
    this.name = "TranscriptionQuotaError";
    this.status = status;
    this.detail = message;
  }
}

export function isTranscriptionQuotaError(
  error: unknown
): error is TranscriptionQuotaError {
  return error instanceof TranscriptionQuotaError;
}

export function isTranscriptionCancelledError(error: unknown): boolean {
  return (
    error instanceof TranscriptionCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class TranscriptionService {
  constructor() {}

  private extractUsage(response: {
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      toolUsePromptTokenCount?: number;
      totalTokenCount?: number;
    };
  }): TranscriptionUsage {
    const usage = response.usageMetadata;
    return {
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
      thoughtsTokenCount: usage?.thoughtsTokenCount,
      toolUsePromptTokenCount: usage?.toolUsePromptTokenCount,
      totalTokenCount: usage?.totalTokenCount,
    };
  }

  private wrapApiError(error: unknown): never {
    if (isTranscriptionCancelledError(error)) throw error;
    if (isTranscriptionQuotaError(error)) throw error;

    const msg =
      error instanceof Error ? error.message : String(error);

    // Detect 429 / RESOURCE_EXHAUSTED from Google API
    if (
      msg.includes("429") ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("quota")
    ) {
      // Try to extract structured info
      const statusMatch = msg.match(
        /RESOURCE_EXHAUSTED|quota exceeded/i
      );
      const status = statusMatch
        ? "RESOURCE_EXHAUSTED"
        : "RATE_LIMITED";
      throw new TranscriptionQuotaError(status, msg);
    }

    throw error;
  }

  private throwIfCancelled(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
      throw new TranscriptionCancelledError();
    }
  }

  private async fetchWithTimeoutAndCancel(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    this.throwIfCancelled(abortSignal);

    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      controller.abort();
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        throw new TranscriptionCancelledError();
      }
      if (timedOut) {
        throw new Error(timeoutMessage);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async uploadFileResumable(
    apiKey: string,
    audioBlob: Blob,
    mimeType: string,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<{ uri: string; mimeType: string; expirationTime?: string }> {
    const startResponse = await this.fetchWithTimeoutAndCancel(
      `${RESUMABLE_UPLOAD_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(audioBlob.size),
          "X-Goog-Upload-Header-Content-Type":
            mimeType || "application/octet-stream",
        },
        body: JSON.stringify({
          file: {
            mimeType: mimeType || "application/octet-stream",
          },
        }),
      },
      timeoutMs,
      `File upload initialization timed out after ${timeoutMs} ms`,
      abortSignal
    );

    if (!startResponse.ok) {
      throw new Error(
        `Failed to initialize file upload: ${startResponse.status} ${startResponse.statusText}`
      );
    }

    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error(
        "File upload initialization failed: upload URL not found"
      );
    }

    let offset = 0;
    while (offset < audioBlob.size) {
      this.throwIfCancelled(abortSignal);

      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, audioBlob.size);
      const chunk = audioBlob.slice(offset, end);
      const isFinal = end >= audioBlob.size;
      const uploadCommand = isFinal ? "upload, finalize" : "upload";

      const chunkResponse = await this.fetchWithTimeoutAndCancel(
        uploadUrl,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Command": uploadCommand,
            "X-Goog-Upload-Offset": String(offset),
            "Content-Length": String(end - offset),
          },
          body: chunk,
        },
        timeoutMs,
        `File upload timed out after ${timeoutMs} ms`,
        abortSignal
      );

      if (!chunkResponse.ok) {
        throw new Error(
          `File upload failed: ${chunkResponse.status} ${chunkResponse.statusText}`
        );
      }

      const uploadStatus = chunkResponse.headers.get("x-goog-upload-status");

      if (isFinal) {
        if (uploadStatus !== "final") {
          throw new Error("File upload failed: upload not finalized");
        }

        const payload = await chunkResponse.json();
        const file = payload?.file;
        if (!file?.uri || !file?.mimeType) {
          throw new Error(
            "File upload failed: file URI or MIME type missing in response"
          );
        }

        return {
          uri: file.uri,
          mimeType: file.mimeType,
          expirationTime: file.expirationTime,
        };
      }

      if (uploadStatus !== "active") {
        throw new Error(
          `File upload failed: unexpected upload status '${
            uploadStatus ?? "unknown"
          }'`
        );
      }

      offset = end;
    }

    throw new Error("File upload failed: no finalized response received");
  }

  private async raceWithTimeoutAndCancel<T>(
    work: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new TranscriptionCancelledError());
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        cleanup();
        reject(new TranscriptionCancelledError());
      };

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
      };

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      work.then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  }

  async classifyTranscript(
    apiKey: string,
    transcriptionText: string,
    categoryNames: string[],
    model: string,
    timeoutMs: number = 6 * 60 * 1000,
    onApiRequestStart?: () => void,
    onApiRequestComplete?: (elapsedMs: number) => void,
    abortSignal?: AbortSignal
  ): Promise<TranscriptionResult> {
    const categoryList = categoryNames.map((n) => `- ${n}`).join("\n");
    const prompt =
      `Classify the following transcript into exactly one of these categories:\n${categoryList}\n\n` +
      `Rules:\n` +
      `- Respond with ONLY the category name from the list above.\n` +
      `- Do not add any explanation, punctuation, or extra text.\n` +
      `- If the transcript does not clearly fit any category, respond with "General".\n\n` +
      `Transcript:\n${transcriptionText}`;

    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      onApiRequestStart?.();
      const apiRequestStartAt = performance.now();

      const response = await this.raceWithTimeoutAndCancel(
        ai.models.generateContent({
          model: model,
          contents: createUserContent([prompt]),
          config: { abortSignal },
        }),
        timeoutMs,
        `Classification timed out after ${timeoutMs} ms`,
        abortSignal
      );

      if (!response.text) {
        throw new Error("No text response from model");
      }

      const text = response.text;
      const usageInfo = this.extractUsage(response);

      const apiRequestElapsedMs = Math.round(
        performance.now() - apiRequestStartAt
      );
      onApiRequestComplete?.(apiRequestElapsedMs);

      return { text, usage: usageInfo };
    } catch (error) {
      if (!isTranscriptionCancelledError(error)) {
        console.error("Classification failed:", error);
      }
      this.wrapApiError(error);
    }
  }

  async summarizeText(
    apiKey: string,
    prompt: string,
    transcriptionText: string,
    model: string,
    timeoutMs: number = 6 * 60 * 1000,
    onApiRequestStart?: () => void,
    onApiRequestComplete?: (elapsedMs: number) => void,
    abortSignal?: AbortSignal
  ): Promise<TranscriptionResult> {
    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      onApiRequestStart?.();
      const apiRequestStartAt = performance.now();

      const response = await this.raceWithTimeoutAndCancel(
        ai.models.generateContent({
          model: model,
          contents: createUserContent([
            `${prompt}\n\n${transcriptionText}`,
          ]),
          config: {
            abortSignal,
          },
        }),
        timeoutMs,
        `Summarization timed out after ${timeoutMs} ms`,
        abortSignal
      );

      if (!response.text) {
        throw new Error("No text response from model");
      }

      const text = response.text;
      const usageInfo = this.extractUsage(response);

      const apiRequestElapsedMs = Math.round(
        performance.now() - apiRequestStartAt
      );
      onApiRequestComplete?.(apiRequestElapsedMs);

      return {
        text,
        usage: usageInfo,
      };
    } catch (error) {
      if (!isTranscriptionCancelledError(error)) {
        console.error("Summarization failed:", error);
      }
      this.wrapApiError(error);
    }
  }

  async transcribe(
    apiKey: string,
    prompt: string,
    audioBase64: string,
    mimeType: string,
    model: string,
    timeoutMs: number = 6 * 60 * 1000,
    onFileUploadStart?: () => void,
    onFileUploadComplete?: (elapsedMs: number, uploadedFile: UploadedFileInfo) => void,
    onApiRequestStart?: () => void,
    onApiRequestComplete?: (elapsedMs: number) => void,
    abortSignal?: AbortSignal,
    disableThinking?: boolean,
    cachedFile?: UploadedFileInfo
  ): Promise<TranscriptionResult> {
    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      let uploadedFile: UploadedFileInfo;

      if (cachedFile) {
        // Reuse cached file URI — skip upload
        uploadedFile = cachedFile;
      } else {
        // convert base64 to Buffer and then to Blob
        const audioBuffer = Buffer.from(audioBase64, "base64");
        const audioBlob = new Blob([audioBuffer], {
          type: mimeType || "application/octet-stream",
        });

        // upload file to Google Gen AI
        const uploadStartAt = performance.now();
        onFileUploadStart?.();
        uploadedFile = await this.uploadFileResumable(
          apiKey,
          audioBlob,
          mimeType || "application/octet-stream",
          timeoutMs,
          abortSignal
        );
        const uploadElapsedMs = Math.round(performance.now() - uploadStartAt);
        onFileUploadComplete?.(uploadElapsedMs, uploadedFile);
      }

      if (!uploadedFile.uri) {
        throw new Error("File upload failed: URI not returned");
      }

      if (!uploadedFile.mimeType) {
        throw new Error("File upload failed: MIME type not returned");
      }

      // API request start - measure API request time separately
      onApiRequestStart?.();
      const apiRequestStartAt = performance.now();

      // create content and receive response
      const response = await this.raceWithTimeoutAndCancel(
        ai.models.generateContent({
          model: model,
          contents: createUserContent([
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            prompt,
          ]),
          config: {
            abortSignal,
            ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
        timeoutMs,
        `Transcription timed out after ${timeoutMs} ms`,
        abortSignal
      );

      if (!response.text) {
        throw new Error("No text response from model");
      }

      const text = response.text;

      const usageInfo = this.extractUsage(response);

      const apiRequestElapsedMs = Math.round(
        performance.now() - apiRequestStartAt
      );
      onApiRequestComplete?.(apiRequestElapsedMs);

      return {
        text,
        usage: usageInfo,
        uploadedFile,
      };
    } catch (error) {
      if (!isTranscriptionCancelledError(error)) {
        console.error("Transcription failed:", error);
      }
      this.wrapApiError(error);
    }
  }

}
