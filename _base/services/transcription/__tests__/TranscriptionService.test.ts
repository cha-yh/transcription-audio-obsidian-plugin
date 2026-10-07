import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TranscriptionCancelledError,
  TranscriptionQuotaError,
  isTranscriptionCancelledError,
  isTranscriptionQuotaError,
  TranscriptionService,
  extractInteractionText,
  extractInteractionUsage,
  type TranscriptionAudioSource,
} from "../TranscriptionService";
import type { TranscriptionOptions } from "../transcriptionConfig";

// Shared mock for generateContent
const mockGenerateContent = vi.fn();

// Mock @google/genai
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
  createUserContent: vi.fn((args: any) => args),
}));

// Mock global fetch for uploadFileResumable and the Interactions API
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
    const transcribeModel = "gemini-3.5-transcribe";
    const defaultOptions: TranscriptionOptions = {
      transcriptionMode: "verbatim",
      speakerDiarization: false,
      wordTimestamps: false,
      customVocabulary: "",
      languageCodes: "",
    };
    const cachedFile = {
      uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
      mimeType: "audio/mp4",
    };

    function mockInteraction(body: unknown, status = 200) {
      mockFetch.mockResolvedValueOnce({
        ok: status === 200,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
    }

    function textResponse(text: string) {
      return {
        steps: [{ type: "model_output", content: [{ type: "text", text }] }],
        usage: { total_input_tokens: 10, total_tokens: 20 },
      };
    }

    function transcribe(
      audio: TranscriptionAudioSource = audioSource(),
      options: TranscriptionOptions = defaultOptions,
      abortSignal?: AbortSignal,
      offsetMs?: number
    ) {
      return service.transcribe(
        apiKey,
        audio,
        transcribeModel,
        options,
        60000,
        undefined,
        undefined,
        undefined,
        undefined,
        abortSignal,
        offsetMs
      );
    }

    it("uploads, then returns text, usage, and uploadedFile", async () => {
      mockFileUpload();
      mockInteraction(textResponse("Hello world"));

      const result = await transcribe();

      expect(result.text).toBe("Hello world");
      expect(result.usage.promptTokenCount).toBe(10);
      expect(result.usage.totalTokenCount).toBe(20);
      expect(result.uploadedFile!.uri).toBe("gs://bucket/file");
      const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(JSON.parse(init.body).input[0].uri).toBe("gs://bucket/file");
    });

    it("calls the Interactions API with only the file at default options", async () => {
      mockInteraction(textResponse("안녕"));

      const result = await transcribe({ kind: "cached", file: cachedFile });

      expect(result.text).toBe("안녕");
      expect(result.uploadedFile).toEqual(cachedFile);
      expect(mockGenerateContent).not.toHaveBeenCalled();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/interactions"
      );
      expect(init.headers["x-goog-api-key"]).toBe(apiKey);
      expect(JSON.parse(init.body)).toEqual({
        model: "models/gemini-3.5-transcribe",
        input: [
          { type: "audio", uri: cachedFile.uri, mime_type: "audio/mp4" },
        ],
      });
    });

    // Regression test for issue #3: the upload path used Buffer.from() to turn
    // base64 back into bytes, which threw "Buffer is not defined" on Android.
    // Removing the global only around the call keeps vitest's own Buffer use
    // (error serialisation) intact.
    it("uploads without Node's Buffer, as the mobile WebView has none", async () => {
      mockFileUpload();
      mockInteraction(textResponse("mobile ok"));

      const nodeBuffer = globalThis.Buffer;
      // @ts-expect-error deleting a Node global to emulate the mobile runtime
      delete globalThis.Buffer;
      try {
        const result = await transcribe();
        expect(result.text).toBe("mobile ok");
      } finally {
        globalThis.Buffer = nodeBuffer;
      }
    });

    it("sends the transcription options and formats speakers from annotations", async () => {
      mockInteraction({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "안녕 네",
                annotations: [
                  {
                    type: "word_info",
                    text: "안녕",
                    speaker: "spk_1",
                    start_offset: "1.000s",
                    end_offset: "1.400s",
                  },
                  {
                    type: "word_info",
                    text: "네",
                    speaker: "spk_2",
                    start_offset: "2.000s",
                    end_offset: "2.200s",
                  },
                ],
              },
            ],
          },
        ],
      });

      const result = await transcribe(
        { kind: "cached", file: cachedFile },
        {
          ...defaultOptions,
          speakerDiarization: true,
          wordTimestamps: true,
          languageCodes: "ko-KR",
        },
        undefined,
        60_000
      );

      expect(result.text).toBe(
        "[01:01] **Speaker 1:** 안녕\n\n[01:02] **Speaker 2:** 네"
      );
      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body).generation_config).toEqual({
        transcription_config: {
          language_codes: ["ko-KR"],
          mode: {
            type: "verbatim",
            diarization_mode: "speaker",
            timestamp_granularities: ["word"],
          },
        },
      });
    });

    it("falls back to the plain text when speakers were asked for but no annotations came back", async () => {
      mockInteraction({ output_text: "plain" });

      const result = await transcribe(
        { kind: "cached", file: cachedFile },
        { ...defaultOptions, speakerDiarization: true }
      );

      expect(result.text).toBe("plain");
    });

    it("fails when the model returns no text", async () => {
      mockInteraction({ steps: [] });

      await expect(
        transcribe({ kind: "cached", file: cachedFile })
      ).rejects.toThrow("No text response from model");
    });

    it("throws TranscriptionCancelledError when signal is aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        transcribe(audioSource(), defaultOptions, abortController.signal)
      ).rejects.toThrow(TranscriptionCancelledError);
    });

    it("reports a quota response as TranscriptionQuotaError", async () => {
      mockInteraction(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
        429
      );

      await expect(
        transcribe({ kind: "cached", file: cachedFile })
      ).rejects.toBeInstanceOf(TranscriptionQuotaError);
    });

    it("throws a non-quota failure with the response body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "INVALID_ARGUMENT",
      });

      await expect(
        transcribe({ kind: "cached", file: cachedFile })
      ).rejects.toThrow("400 Bad Request INVALID_ARGUMENT");
    });

    it("throws the original error for a network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network failure"));

      await expect(
        transcribe({ kind: "cached", file: cachedFile })
      ).rejects.toThrow("Network failure");
    });

    it("throws when apiKey is empty", async () => {
      await expect(
        service.transcribe(
          "",
          audioSource(),
          transcribeModel,
          defaultOptions,
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
      mockInteraction(textResponse("long"));

      await transcribe({ kind: "upload", blob, mimeType: "audio/wav" });

      // one start request, one per part, then the transcription request
      expect(mockFetch).toHaveBeenCalledTimes(5);

      const uploadCalls = mockFetch.mock.calls.slice(1, 4);
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

      await expect(transcribe()).rejects.toThrow("upload URL not found");
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
        transcribe({ kind: "upload", blob, mimeType: "audio/wav" })
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
        ["1on1", "Tech Meeting"],
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

describe("extractInteractionText", () => {
  it("prefers output_text when the response carries it", () => {
    expect(extractInteractionText({ output_text: "whole", steps: [] })).toBe(
      "whole"
    );
  });

  it("joins the text parts of model output steps only", () => {
    expect(
      extractInteractionText({
        steps: [
          { type: "user_input", content: [{ type: "text", text: "no" }] },
          {
            type: "model_output",
            content: [
              { type: "text", text: "Hello " },
              { type: "audio" },
              { type: "text", text: "world" },
            ],
          },
        ],
      })
    ).toBe("Hello world");
  });

  it("returns an empty string for a response without text", () => {
    expect(extractInteractionText({})).toBe("");
    expect(extractInteractionText(null)).toBe("");
  });
});

describe("extractInteractionUsage", () => {
  it("maps the usage counts it recognizes and leaves the rest undefined", () => {
    expect(
      extractInteractionUsage({
        usage: { total_input_tokens: 7, total_tokens: "12" },
      })
    ).toEqual({
      promptTokenCount: 7,
      candidatesTokenCount: undefined,
      thoughtsTokenCount: undefined,
      toolUsePromptTokenCount: undefined,
      totalTokenCount: undefined,
    });
  });
});
