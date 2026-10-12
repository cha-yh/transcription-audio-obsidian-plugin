import { describe, it, expect } from "vitest";
import {
  audioNameOfTranscript,
  buildSummaryContent,
  fileTimestamp,
  isTranscriptFileName,
  nestHeadingsUnder,
  pickTranscriptLink,
  readTranscriptBody,
  summaryEmbed,
  summaryFilePath,
} from "../summaryFile";

const createdAt = new Date("2026-10-12T00:23:21.456Z");

describe("fileTimestamp", () => {
  it("matches the stamp transcript files end with", () => {
    expect(fileTimestamp(createdAt)).toBe("2026-10-12T00-23-21");
  });
});

describe("isTranscriptFileName", () => {
  it("accepts a finished transcript file", () => {
    expect(
      isTranscriptFileName("_transcription_Recording_2026-10-12T00-23-21.md")
    ).toBe(true);
  });

  it("rejects a transcript still being written, summaries and notes", () => {
    expect(
      isTranscriptFileName("_transcription_Recording_2026-10-12T00-23-21_temp.md")
    ).toBe(false);
    expect(
      isTranscriptFileName("_summary_Recording_2026-10-12T00-23-21.md")
    ).toBe(false);
    expect(isTranscriptFileName("Meeting.md")).toBe(false);
  });
});

describe("audioNameOfTranscript", () => {
  it("strips the prefix, the stamp and the folder", () => {
    expect(
      audioNameOfTranscript(
        "Audio/_transcription_Recording 20260522164450_2026-10-11T10-00-00.md"
      )
    ).toBe("Recording 20260522164450");
  });

  it("keeps underscores that belong to the audio name", () => {
    expect(
      audioNameOfTranscript("_transcription_team_sync_2026-10-11T10-00-00.md")
    ).toBe("team_sync");
  });
});

describe("summaryFilePath", () => {
  it("names the summary like its transcript, in the same folder", () => {
    expect(
      summaryFilePath(
        "Audio/_transcription_Recording 20260522164450_2026-10-11T10-00-00.md",
        createdAt
      )
    ).toBe("Audio/_summary_Recording 20260522164450_2026-10-12T00-23-21.md");
  });

  it("works at the vault root", () => {
    expect(
      summaryFilePath("_transcription_a_2026-10-11T10-00-00.md", createdAt)
    ).toBe("_summary_a_2026-10-12T00-23-21.md");
  });
});

describe("summaryEmbed", () => {
  it("embeds the Summary heading by file name", () => {
    expect(
      summaryEmbed(
        "Audio/_summary_Recording 20260522164450_2026-10-12T00-23-21.md"
      )
    ).toBe("![[_summary_Recording 20260522164450_2026-10-12T00-23-21#Summary]]");
  });
});

describe("nestHeadingsUnder", () => {
  it("pushes top-level headings below the parent, keeping their order", () => {
    expect(nestHeadingsUnder("# A\ntext\n## B", 1)).toBe("## A\ntext\n### B");
  });

  it("leaves headings that are already nested alone", () => {
    const text = "## A\n### B";
    expect(nestHeadingsUnder(text, 1)).toBe(text);
  });

  it("does not touch lines inside fenced code", () => {
    expect(nestHeadingsUnder("# A\n```\n# not a heading\n```", 1)).toBe(
      "## A\n```\n# not a heading\n```"
    );
  });

  it("caps at level 6", () => {
    expect(nestHeadingsUnder("# A\n###### F", 1)).toBe("## A\n###### F");
  });
});

describe("buildSummaryContent", () => {
  it("writes frontmatter and the Summary section", () => {
    const content = buildSummaryContent({
      transcriptPath: "Audio/_transcription_a_2026-10-11T10-00-00.md",
      audioPath: "Audio/a.m4a",
      category: "Meeting",
      summary: "# Notes\n- one\n",
      createdAt,
    });
    expect(content).toBe(
      [
        "---",
        'transcript: "[[_transcription_a_2026-10-11T10-00-00]]"',
        'audio: "Audio/a.m4a"',
        'category: "Meeting"',
        "created: 2026-10-12T00:23:21.456Z",
        "---",
        "",
        "# Summary",
        "",
        "## Notes",
        "- one",
        "",
      ].join("\n")
    );
  });

  it("leaves out fields it does not have", () => {
    const content = buildSummaryContent({
      transcriptPath: "_transcription_a_2026-10-11T10-00-00.md",
      summary: "text",
      createdAt,
    });
    expect(content).not.toContain("audio:");
    expect(content).not.toContain("category:");
  });
});

describe("readTranscriptBody", () => {
  it("returns what follows the Transcription heading", () => {
    expect(
      readTranscriptBody('---\naudio: "a.m4a"\n---\n\n## Transcription\n\nhello\n')
    ).toBe("hello");
  });

  it("is empty for a file without that section", () => {
    expect(readTranscriptBody("# Some note\n\ntext")).toBe("");
  });
});

describe("pickTranscriptLink", () => {
  const note = [
    "![[memo.m4a]]",
    "[[_transcription_memo_2026-10-11T10-00-00.md]]",
    "",
    "Later meeting:",
    "[[Audio/_transcription_sync_2026-10-11T12-00-00|transcript]]",
  ].join("\n");

  it("takes the last transcript link before the cursor", () => {
    const cursor = note.indexOf("Later");
    expect(pickTranscriptLink(note, cursor)?.linkpath).toBe(
      "_transcription_memo_2026-10-11T10-00-00.md"
    );
    expect(pickTranscriptLink(note, note.length)?.linkpath).toBe(
      "Audio/_transcription_sync_2026-10-11T12-00-00"
    );
  });

  it("falls back to the first link when none is before the cursor", () => {
    expect(pickTranscriptLink(note, 0)?.linkpath).toBe(
      "_transcription_memo_2026-10-11T10-00-00.md"
    );
  });

  it("reports where the link ends so the embed can follow its line", () => {
    const link = pickTranscriptLink(note, note.indexOf("Later"));
    expect(note.slice(0, link!.end).endsWith("10-00-00.md]]")).toBe(true);
  });

  it("reads markdown links and ignores other files and temp transcripts", () => {
    expect(
      pickTranscriptLink(
        "[t](Audio/_transcription_a%20b_2026-10-11T10-00-00.md)",
        100
      )?.linkpath
    ).toBe("Audio/_transcription_a b_2026-10-11T10-00-00.md");
    expect(pickTranscriptLink("[[memo.m4a]] [[Notes]]", 100)).toBeNull();
    expect(
      pickTranscriptLink("[[_transcription_a_2026-10-11T10-00-00_temp]]", 100)
    ).toBeNull();
  });
});
