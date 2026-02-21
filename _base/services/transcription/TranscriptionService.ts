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
}

export class TranscriptionCancelledError extends Error {
  constructor() {
    super("Transcription was cancelled by user.");
    this.name = "TranscriptionCancelledError";
  }
}

export function isTranscriptionCancelledError(error: unknown): boolean {
  return (
    error instanceof TranscriptionCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class TranscriptionService {
  constructor() {}

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
  ): Promise<{ uri: string; mimeType: string }> {
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
      throw new Error("File upload initialization failed: upload URL not found");
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
        };
      }

      if (uploadStatus !== "active") {
        throw new Error(
          `File upload failed: unexpected upload status '${uploadStatus ?? "unknown"}'`
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

  async transcribe(
    apiKey: string,
    prompt: string,
    audioBase64: string,
    mimeType: string,
    model: string,
    timeoutMs: number = 6 * 60 * 1000,
    onFileUploadStart?: () => void,
    onFileUploadComplete?: (elapsedMs: number) => void,
    onApiRequestStart?: () => void,
    onApiRequestComplete?: (elapsedMs: number) => void,
    abortSignal?: AbortSignal
  ): Promise<TranscriptionResult> {
    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      // convert base64 to Buffer and then to Blob
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const audioBlob = new Blob([audioBuffer], {
        type: mimeType || "application/octet-stream",
      });

      // upload file to Google Gen AI
      const uploadStartAt = performance.now();
      onFileUploadStart?.();
      const uploadedFile = await this.uploadFileResumable(
        apiKey,
        audioBlob,
        mimeType || "application/octet-stream",
        timeoutMs,
        abortSignal
      );
      const uploadElapsedMs = Math.round(performance.now() - uploadStartAt);
      onFileUploadComplete?.(uploadElapsedMs);

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
            createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
            prompt,
          ]),
          config: {
            abortSignal,
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

      const usage = response.usageMetadata;
      const usageInfo: TranscriptionUsage = {
        promptTokenCount: usage?.promptTokenCount,
        candidatesTokenCount: usage?.candidatesTokenCount,
        thoughtsTokenCount: usage?.thoughtsTokenCount,
        toolUsePromptTokenCount: usage?.toolUsePromptTokenCount,
        totalTokenCount: usage?.totalTokenCount,
      };

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
        console.error("Transcription failed:", error);
      }
      throw error;
    }
  }
}
