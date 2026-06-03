import { describe, it, expect, vi } from "vitest";
import { ObsidianFileService } from "../obsidianFileService";
import { AUDIO_FILE_REGEX } from "_base/constants/regex";

function createMockApp(
  files: { path: string; name: string }[],
  existingFullPaths: string[] = []
) {
  return {
    vault: {
      getAbstractFileByPath: vi.fn((p: string) => {
        if (existingFullPaths.includes(p)) {
          return { path: p };
        }
        return null;
      }),
      getFiles: vi.fn(() =>
        files.map((f) => ({ path: f.path, name: f.name }))
      ),
    },
  } as any;
}

describe("ObsidianFileService.findFilePath", () => {
  it("extracts filename from wiki link [[audio.mp3]]", () => {
    const app = createMockApp(
      [{ path: "audio.mp3", name: "audio.mp3" }],
      ["audio.mp3"]
    );
    const svc = new ObsidianFileService(app);
    expect(svc.findFilePath("some text [[audio.mp3]] more", AUDIO_FILE_REGEX)).toBe(
      "audio.mp3"
    );
  });

  it("extracts filename from embed link ![[audio.m4a]]", () => {
    const app = createMockApp(
      [{ path: "audio.m4a", name: "audio.m4a" }],
      ["audio.m4a"]
    );
    const svc = new ObsidianFileService(app);
    expect(
      svc.findFilePath("![[audio.m4a]]", AUDIO_FILE_REGEX)
    ).toBe("audio.m4a");
  });

  it("extracts filename from markdown link [label](audio.wav)", () => {
    const app = createMockApp(
      [{ path: "audio.wav", name: "audio.wav" }],
      ["audio.wav"]
    );
    const svc = new ObsidianFileService(app);
    expect(
      svc.findFilePath("[my file](audio.wav)", AUDIO_FILE_REGEX)
    ).toBe("audio.wav");
  });

  it("throws when no audio file in text", () => {
    const app = createMockApp([]);
    const svc = new ObsidianFileService(app);
    expect(() =>
      svc.findFilePath("no audio links here", AUDIO_FILE_REGEX)
    ).toThrow("No file found");
  });

  it("returns the last match when multiple audio links exist", () => {
    const app = createMockApp(
      [
        { path: "first.mp3", name: "first.mp3" },
        { path: "second.wav", name: "second.wav" },
      ],
      ["second.wav"]
    );
    const svc = new ObsidianFileService(app);
    const result = svc.findFilePath(
      "[[first.mp3]] and [[second.wav]]",
      AUDIO_FILE_REGEX
    );
    expect(result).toBe("second.wav");
  });

  it("falls back to filename search when full path not found", () => {
    const app = createMockApp([
      { path: "recordings/audio.mp3", name: "audio.mp3" },
    ]);
    const svc = new ObsidianFileService(app);
    expect(
      svc.findFilePath("[[audio.mp3]]", AUDIO_FILE_REGEX)
    ).toBe("recordings/audio.mp3");
  });

  it("throws when file not found anywhere", () => {
    const app = createMockApp([]);
    const svc = new ObsidianFileService(app);
    expect(() =>
      svc.findFilePath("[[missing.mp3]]", AUDIO_FILE_REGEX)
    ).toThrow("File not found");
  });
});
