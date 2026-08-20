import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TranscriptionCancelledError,
  TranscriptionQuotaError,
  isTranscriptionCancelledError,
  isTranscriptionQuotaError,
  TranscriptionService,
} from "../TranscriptionService";

// Shared mock for generateContent
const mockGenerateContent = vi.fn();

// Mock @google/genai
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
  createUserContent: vi.fn((args: any) => args),
  createPartFromUri: vi.fn((uri: string, mime: string) => ({ uri, mime })),
}));

// Mock global fetch for uploadFileResumable
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Bytes to upload, in the shape transcribe() now takes. */
function audioSource(bytes = new Uint8Array([1, 2, 3])) {
  return {
    kind: "upload" as const,
    blob: new Blob([bytes], { type: "audio/wav" }),
    mimeType: "audio/wav",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued mockResolvedValueOnce implementations, so a test
  // that leaves part of its upload queue unused would feed the next one.
  mockFetch.mockReset();
  mockGenerateContent.mockReset();
});

describe("TranscriptionCancelledError", () => {
  it("has correct name and message", () => {
    const err = new TranscriptionCancelledError();
    expect(err.name).toBe("TranscriptionCancelledError");
    expect(err.message).toBe("Transcription was cancelled by user.");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("TranscriptionQuotaError", () => {
  it("has status and detail fields", () => {
    const err = new TranscriptionQuotaError("RESOURCE_EXHAUSTED", "quota hit");
    expect(err.name).toBe("TranscriptionQuotaError");
    expect(err.status).toBe("RESOURCE_EXHAUSTED");
    expect(err.detail).toBe("quota hit");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("isTranscriptionCancelledError", () => {
  it("returns true for TranscriptionCancelledError", () => {
    expect(
      isTranscriptionCancelledError(new TranscriptionCancelledError())
    ).toBe(true);
  });

  it("returns true for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isTranscriptionCancelledError(err)).toBe(true);
  });

  it("returns false for a generic error", () => {
    expect(isTranscriptionCancelledError(new Error("oops"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isTranscriptionCancelledError("string")).toBe(false);
    expect(isTranscriptionCancelledError(null)).toBe(false);
  });
});

describe("isTranscriptionQuotaError", () => {
  it("returns true for TranscriptionQuotaError", () => {
    expect(
      isTranscriptionQuotaError(
        new TranscriptionQuotaError("RATE_LIMITED", "x")
      )
    ).toBe(true);
  });

  it("returns false for a generic error", () => {
    expect(isTranscriptionQuotaError(new Error("oops"))).toBe(false);
  });
});

// Helper to set up fetch mocks for file upload
/**
 * Queues the fetch responses for one resumable upload.
 *
 * `chunks` is how many 8 MB parts the blob is expected to take: every part but
 * the last answers "active", the last one answers "final" with the file payload.
 * `exposeUploadUrl: false` drops the x-goog-upload-url response header, which is
 * what a CORS setup that does not expose it looks like from inside a WebView.
 */
function mockFileUpload({
  chunks = 1,
  exposeUploadUrl = true,
}: { chunks?: number; exposeUploadUrl?: boolean } = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers(
      exposeUploadUrl
        ? { "x-goog-upload-url": "https://upload.example.com/resume" }
        : {}
    ),
  });

  for (let i = 0; i < chunks - 1; i++) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "x-goog-upload-status": "active" }),
    });
  }

  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: new Headers({ "x-goog-upload-status": "final" }),
    json: async () => ({
      file: {
        uri: "gs://bucket/file",
        mimeType: "audio/wav",
        expirationTime: "2099-01-01T00:00:00Z",
      },
    }),
  });
}

describe("TranscriptionService", () => {
  const service = new TranscriptionService();
  const apiKey = "test-key";
  const model = "gemini-3.7-flash";

  describe("transcribe", () => {
    it("returns text, usage, and uploadedFile on success", async () => {
      mockFileUpload();
      mockGenerateContent.mockResolvedValueOnce({
        text: "Hello world",
        usageMetadata: { promptTokenCount: 10, totalTokenCount: 20 },
      });

      const result = await service.transcribe(
        apiKey,
        "prompt",
        audioSource(),
        model,
        60000
      );

      expect(result.text).toBe("Hello world");
      expect(result.usage.promptTokenCount).toBe(10);
      expect(result.uploadedFile).toBeDefined();
      expect(result.uploadedFile!.uri).toBe("gs://bucket/file");
    });

    // Regression test for issue #3: the upload path used Buffer.from() to turn
    // base64 back into bytes, which threw "Buffer is not defined" on Android.
    // Removing the global only around the call keeps vitest's own Buffer use
    // (error serialisation) intact.
    it("uploads without Node's Buffer, as the mobile WebView has none", async () => {
      mockFileUpload();
      mockGenerateContent.mockResolvedValueOnce({
        text: "mobile ok",
        usageMetadata: { totalTokenCount: 3 },
      });

      const nodeBuffer = globalThis.Buffer;
      // @ts-expect-error deleting a Node global to emulate the mobile runtime
      delete globalThis.Buffer;
      try {
        const result = await service.transcribe(
          apiKey,
          "prompt",
          audioSource(),
          model,
          60000
        );
        expect(result.text).toBe("mobile ok");
      } finally {
        globalThis.Buffer = nodeBuffer;
      }
    });

    it("skips upload when cachedFile is provided", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: "cached result",
        usageMetadata: { totalTokenCount: 5 },
      });

      const cachedFile = {
        uri: "gs://bucket/cached",
        mimeType: "audio/wav",
        expirationTime: "2099-01-01T00:00:00Z",
      };

      const result = await service.transcribe(
        apiKey,
        "prompt",
        { kind: "cached", file: cachedFile },
        model,
        60000
      );

      expect(result.text).toBe("cached result");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("passes thinkingBudget: 0 when disableThinking is true", async () => {
      mockFileUpload();
      mockGenerateContent.mockResolvedValueOnce({
        text: "result",
        usageMetadata: {},
      });

      await service.transcribe(
        apiKey,
        "prompt",
        audioSource(),
        model,
        60000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true // disableThinking
      );

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            thinkingConfig: { thinkingBudget: 0 },
          }),
        })
      );
    });

    it("throws TranscriptionCancelledError when signal is aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        service.transcribe(
          apiKey,
          "prompt",
          audioSource(),
          model,
          60000,
          undefined,
          undefined,
          undefined,
          undefined,
          abortController.signal
        )
      ).rejects.toThrow(TranscriptionCancelledError);
    });

    it("wraps 429 errors as TranscriptionQuotaError", async () => {
      mockFileUpload();
      mockGenerateContent.mockRejectedValueOnce(
        new Error("429 Too Many Requests")
      );

      await expect(
        service.transcribe(
          apiKey,
          "prompt",
          audioSource(),
          model,
          60000
        )
      ).rejects.toThrow(TranscriptionQuotaError);
    });

    it("wraps RESOURCE_EXHAUSTED errors as TranscriptionQuotaError", async () => {
      mockFileUpload();
      mockGenerateContent.mockRejectedValueOnce(
        new Error("RESOURCE_EXHAUSTED: quota exceeded")
      );

      await expect(
        service.transcribe(
          apiKey,
          "prompt",
          audioSource(),
          model,
          60000
        )
      ).rejects.toThrow(TranscriptionQuotaError);
    });

    it("throws original error for non-quota failures", async () => {
      mockFileUpload();
      mockGenerateContent.mockRejectedValueOnce(new Error("Network failure"));

      await expect(
        service.transcribe(
          apiKey,
          "prompt",
          audioSource(),
          model,
          60000
        )
      ).rejects.toThrow("Network failure");
    });

    it("throws when apiKey is empty", async () => {
      await expect(
        service.transcribe(
          "",
          "prompt",
          audioSource(),
          model,
          60000
        )
      ).rejects.toThrow("API Key is not provided");
    });

    it("splits a blob larger than the chunk size across sequential uploads", async () => {
      // 20 MB spans three 8 MB parts, so the while loop runs more than once —
      // the single-part happy path never exercised it.
      const blob = new Blob([new Uint8Array(20 * 1024 * 1024)], {
        type: "audio/wav",
      });
      mockFileUpload({ chunks: 3 });
      mockGenerateContent.mockResolvedValueOnce({
        text: "long",
        usageMetadata: {},
      });

      await service.transcribe(
        apiKey,
        "prompt",
        { kind: "upload", blob, mimeType: "audio/wav" },
        model,
        60000
      );

      // one start request plus one per part
      expect(mockFetch).toHaveBeenCalledTimes(4);

      const uploadCalls = mockFetch.mock.calls.slice(1);
      expect(
        uploadCalls.map((call) => call[1].headers["X-Goog-Upload-Offset"])
      ).toEqual(["0", "8388608", "16777216"]);
      expect(
        uploadCalls.map((call) => call[1].headers["X-Goog-Upload-Command"])
      ).toEqual(["upload", "upload", "upload, finalize"]);
    });

    it("fails clearly when the upload URL header is not readable", async () => {
      // A WebView that cannot see x-goog-upload-url (not exposed by CORS) ends
      // up here rather than somewhere further down the upload.
      mockFileUpload({ exposeUploadUrl: false });

      await expect(
        service.transcribe(apiKey, "prompt", audioSource(), model, 60000)
      ).rejects.toThrow("upload URL not found");
    });

    it("reports a chunk that is not acknowledged as active", async () => {
      const blob = new Blob([new Uint8Array(12 * 1024 * 1024)], {
        type: "audio/wav",
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({
            "x-goog-upload-url": "https://upload.example.com/resume",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({}),
        });

      await expect(
        service.transcribe(
          apiKey,
          "prompt",
          { kind: "upload", blob, mimeType: "audio/wav" },
          model,
          60000
        )
      ).rejects.toThrow("unexpected upload status");
    });
  });

  describe("classifyTranscript", () => {
    it("returns classification text on success", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: "Tech Meeting",
        usageMetadata: { totalTokenCount: 5 },
      });

      const result = await service.classifyTranscript(
        apiKey,
        "some transcript",
        ["1on1", "Tech Meeting", "General"],
        model
      );

      expect(result.text).toBe("Tech Meeting");
    });
  });

  describe("summarizeText", () => {
    it("returns summarized text on success", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: "Summary of the meeting...",
        usageMetadata: { totalTokenCount: 15 },
      });

      const result = await service.summarizeText(
        apiKey,
        "Summarize this:",
        "raw transcript content",
        model
      );

      expect(result.text).toBe("Summary of the meeting...");
      expect(result.usage.totalTokenCount).toBe(15);
    });
  });
});
