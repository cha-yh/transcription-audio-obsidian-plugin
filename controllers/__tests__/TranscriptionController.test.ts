import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptionController } from "../TranscriptionController";
import {
  createTestWavBuffer,
  createNonPcm16WavBuffer,
} from "../../tests/helpers/createTestWavBuffer";

// Use vi.hoisted so the class is available inside vi.mock (which is hoisted)
const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    path: string;
    name: string;
    stat = { mtime: 0 };
    constructor(p: string = "") {
      this.path = p;
      this.name = p;
    }
  }
  return { MockTFile };
});

// Mock obsidian
vi.mock("obsidian", () => {
  return {
    TFile: MockTFile,
    TAbstractFile: class {
      path = "";
    },
    App: class {},
    Editor: class {},
    Notice: class {
      constructor(_msg: string) {}
    },
  };
});

// Mock dependencies
vi.mock("../../_base/services/transcription/TranscriptionService", () => ({
  TranscriptionService: class {
    transcribe = vi.fn();
    classifyTranscript = vi.fn();
    summarizeText = vi.fn();
  },
  TranscriptionCancelledError: class extends Error {
    constructor() {
      super("cancelled");
      this.name = "TranscriptionCancelledError";
    }
  },
  isTranscriptionCancelledError: (e: any) =>
    e?.name === "TranscriptionCancelledError" || e?.name === "AbortError",
  isTranscriptionQuotaError: (e: any) =>
    e?.name === "TranscriptionQuotaError",
  TranscriptionQuotaError: class extends Error {
    status: string;
    detail: string;
    constructor(s: string, d: string) {
      super(s);
      this.name = "TranscriptionQuotaError";
      this.status = s;
      this.detail = d;
    }
  },
}));

vi.mock("../../_base/services/audio/AudioService", () => ({
  AudioService: class {
    parseWavHeader = vi.fn();
    sliceWavPcm16 = vi.fn();
    decodeToWavPcm16 = vi.fn();
  },
}));

vi.mock("../../_base/services/obsidian/obsidianFileService", () => ({
  ObsidianFileService: class {
    findFilePath = vi.fn();
  },
}));

vi.mock("../../_base/services/obsidian/ObsidianInteractorService", () => ({
  ObsidianInteractorService: class {
    appendTextToFile = vi.fn();
  },
}));

vi.mock("../../_base/utils/progressBus", () => ({
  progressBus: {
    subscribe: vi.fn(() => vi.fn()),
    publish: vi.fn(),
    clear: vi.fn(),
  },
}));

function createMockApp() {
  return {
    vault: {
      getAbstractFileByPath: vi.fn(),
      readBinary: vi.fn(),
      getFiles: vi.fn(() => []),
      create: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      read: vi.fn(),
      process: vi.fn(),
    },
    workspace: {
      getActiveFile: vi.fn(),
      getLeavesOfType: vi.fn(() => []),
      getRightLeaf: vi.fn(() => null),
      getLeaf: vi.fn(() => ({
        setViewState: vi.fn(),
      })),
      revealLeaf: vi.fn(),
    },
  } as any;
}

describe("TranscriptionController — pure helpers", () => {
  let controller: TranscriptionController;

  beforeEach(() => {
    const app = createMockApp();
    controller = new TranscriptionController(app, "test-progress-view");
  });

  describe("fileTypeToMimeType", () => {
    const callFn = (ext: string | undefined) =>
      (controller as any).fileTypeToMimeType(ext);

    it("maps webm to audio/webm", () => {
      expect(callFn("webm")).toBe("audio/webm");
    });

    it("maps mp3 to audio/mpeg", () => {
      expect(callFn("mp3")).toBe("audio/mpeg");
    });

    it("maps mp4 to audio/mp4", () => {
      expect(callFn("mp4")).toBe("audio/mp4");
    });

    it("maps m4a to audio/mp4", () => {
      expect(callFn("m4a")).toBe("audio/mp4");
    });

    it("maps wav to audio/wav", () => {
      expect(callFn("wav")).toBe("audio/wav");
    });

    it("maps mpeg to audio/mpeg", () => {
      expect(callFn("mpeg")).toBe("audio/mpeg");
    });

    it("maps mpga to audio/mpeg", () => {
      expect(callFn("mpga")).toBe("audio/mpeg");
    });

    it("maps ogg to audio/ogg", () => {
      expect(callFn("ogg")).toBe("audio/ogg");
    });

    it("returns application/octet-stream for unknown ext", () => {
      expect(callFn("xyz")).toBe("application/octet-stream");
    });

    it("returns application/octet-stream for undefined", () => {
      expect(callFn(undefined)).toBe("application/octet-stream");
    });
  });

  describe("isPcm16Wav", () => {
    const callFn = (buf: ArrayBuffer) => (controller as any).isPcm16Wav(buf);

    it("returns true for valid PCM16 WAV", () => {
      const buf = createTestWavBuffer(100);
      expect(callFn(buf)).toBe(true);
    });

    it("returns false for non-WAV buffer", () => {
      const buf = new ArrayBuffer(44);
      expect(callFn(buf)).toBe(false);
    });

    it("returns false for non-PCM16 WAV", () => {
      const buf = createNonPcm16WavBuffer(100);
      expect(callFn(buf)).toBe(false);
    });

    it("returns false for empty buffer", () => {
      expect(callFn(new ArrayBuffer(0))).toBe(false);
    });
  });

  describe("isUploadedFileValid", () => {
    const callFn = (file: any) =>
      (controller as any).isUploadedFileValid(file);

    it("returns true for valid non-expired file", () => {
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      expect(
        callFn({
          uri: "gs://bucket/file",
          mimeType: "audio/wav",
          expirationTime: future,
        })
      ).toBe(true);
    });

    it("returns false for expired file", () => {
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      expect(
        callFn({
          uri: "gs://bucket/file",
          mimeType: "audio/wav",
          expirationTime: past,
        })
      ).toBe(false);
    });

    it("returns false for file expiring within 1 minute", () => {
      const soon = new Date(Date.now() + 30 * 1000).toISOString();
      expect(
        callFn({
          uri: "gs://bucket/file",
          mimeType: "audio/wav",
          expirationTime: soon,
        })
      ).toBe(false);
    });

    it("returns false for null", () => {
      expect(callFn(null)).toBe(false);
    });

    it("returns false for missing uri", () => {
      expect(
        callFn({
          mimeType: "audio/wav",
          expirationTime: new Date(Date.now() + 600000).toISOString(),
        })
      ).toBe(false);
    });

    it("returns false for missing expirationTime", () => {
      expect(
        callFn({ uri: "gs://bucket/file", mimeType: "audio/wav" })
      ).toBe(false);
    });
  });

  describe("createFileWriteQueue", () => {
    it("executes operations sequentially", async () => {
      const app = createMockApp();
      const ctrl = new TranscriptionController(app, "test-progress-view");

      let fileContent = "initial";

      app.vault.getAbstractFileByPath.mockReturnValue(
        Object.assign(Object.create(MockTFile.prototype), {
          path: "test.md",
        })
      );
      app.vault.process.mockImplementation(
        async (_file: any, fn: (data: string) => string) => {
          fileContent = fn(fileContent);
        }
      );

      const queue = (ctrl as any).createFileWriteQueue("test.md");

      const p1 = queue.enqueue((data: string) => data + "-a");
      const p2 = queue.enqueue((data: string) => data + "-b");
      const p3 = queue.enqueue((data: string) => data + "-c");

      await Promise.all([p1, p2, p3]);

      expect(fileContent).toBe("initial-a-b-c");
    });
  });

  describe("finalizeTranscriptionFile", () => {
    it("removes _temp from filename", async () => {
      const app = createMockApp();
      const ctrl = new TranscriptionController(app, "test-progress-view");
      const mockFile = Object.assign(
        Object.create(MockTFile.prototype),
        { path: "dir/_transcription_audio_2024_temp.md" }
      );
      app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      const result = await (ctrl as any).finalizeTranscriptionFile(
        "dir/_transcription_audio_2024_temp.md"
      );

      expect(result).toBe("dir/_transcription_audio_2024.md");
      expect(app.vault.rename).toHaveBeenCalledWith(
        mockFile,
        "dir/_transcription_audio_2024.md"
      );
    });
  });
});
