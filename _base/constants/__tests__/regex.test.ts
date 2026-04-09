import { describe, it, expect, beforeEach } from "vitest";
import { AUDIO_FILE_REGEX } from "../regex";

function matchAudio(text: string): string[] {
  const matches: string[] = [];
  for (const reg of AUDIO_FILE_REGEX) {
    reg.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(text)) !== null) {
      matches.push(m[1]);
    }
  }
  return matches;
}

describe("AUDIO_FILE_REGEX", () => {
  beforeEach(() => {
    for (const reg of AUDIO_FILE_REGEX) reg.lastIndex = 0;
  });

  it("matches [[recording.mp3]]", () => {
    expect(matchAudio("[[recording.mp3]]")).toContain("recording.mp3");
  });

  it("matches ![[recording.m4a]]", () => {
    expect(matchAudio("![[recording.m4a]]")).toContain("recording.m4a");
  });

  it("matches markdown link [label](path/to/audio.wav)", () => {
    expect(matchAudio("[label](path/to/audio.wav)")).toContain(
      "path/to/audio.wav"
    );
  });

  it("does NOT match [[image.png]]", () => {
    expect(matchAudio("[[image.png]]")).toHaveLength(0);
  });

  it("does NOT match [[document.pdf]]", () => {
    expect(matchAudio("[[document.pdf]]")).toHaveLength(0);
  });

  const extensions = ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"];
  for (const ext of extensions) {
    it(`matches wiki link with .${ext}`, () => {
      expect(matchAudio(`[[file.${ext}]]`)).toContain(`file.${ext}`);
    });
  }

  it("matches embed syntax ![[path/audio.mp3]]", () => {
    expect(matchAudio("![[path/audio.mp3]]")).toContain("path/audio.mp3");
  });

  it("matches markdown link with spaces in label", () => {
    expect(matchAudio("[my audio file](recording.webm)")).toContain(
      "recording.webm"
    );
  });
});
