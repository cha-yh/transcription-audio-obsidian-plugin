import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObsidianInteractorService } from "../ObsidianInteractorService";

const { MockTFile, noticeSpy } = vi.hoisted(() => {
  class MockTFile {
    path: string;

    constructor(path: string = "") {
      this.path = path;
    }
  }

  return {
    MockTFile,
    noticeSpy: vi.fn(),
  };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  MarkdownView: class {},
  Notice: class {
    constructor(message: string) {
      noticeSpy(message);
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ObsidianInteractorService.appendTextToFile", () => {
  it("rethrows vault write failures so callers can report failure", async () => {
    const file = new MockTFile("note.md");
    const writeError = new Error("write failed");
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn(() => file),
        process: vi.fn().mockRejectedValue(writeError),
      },
      workspace: {
        getActiveViewOfType: vi.fn(() => null),
      },
    } as any;

    const service = new ObsidianInteractorService(app);

    await expect(
      service.appendTextToFile("note.md", 0, 0, "transcript")
    ).rejects.toThrow("write failed");
    expect(noticeSpy).toHaveBeenCalledWith(
      "Error writing transcript to target file."
    );
  });
});
