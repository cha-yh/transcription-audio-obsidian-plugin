import { describe, it, expect } from "vitest";
import {
  hasChunkMarker,
  readChunkBody,
  replaceChunkBody,
  wrapChunkBody,
} from "../chunkMarkers";

function buildDocument(bodies: string[]): string {
  return (
    "---\naudio: recordings/meeting.m4a\n---\n\n## Transcription\n\n" +
    bodies.map((body, i) => wrapChunkBody(i + 1, body)).join("\n\n") +
    "\n"
  );
}

describe("wrapChunkBody", () => {
  it("wraps the body in open and close markers", () => {
    expect(wrapChunkBody(3, "hello")).toBe("%%chunk:3%%\nhello\n%%/chunk:3%%");
  });

  it("wraps multi-line bodies", () => {
    expect(wrapChunkBody(1, "a\n\nb")).toBe("%%chunk:1%%\na\n\nb\n%%/chunk:1%%");
  });
});

describe("hasChunkMarker", () => {
  it("finds an existing chunk", () => {
    const doc = buildDocument(["one", "two"]);
    expect(hasChunkMarker(doc, 1)).toBe(true);
    expect(hasChunkMarker(doc, 2)).toBe(true);
  });

  it("returns false for a chunk that is not present", () => {
    expect(hasChunkMarker(buildDocument(["one"]), 2)).toBe(false);
  });

  it("returns false for a document written before markers existed", () => {
    expect(hasChunkMarker("## Transcription\n\nplain text\n", 1)).toBe(false);
  });

  it("does not confuse chunk 1 with chunk 10", () => {
    const doc = wrapChunkBody(10, "ten");
    expect(hasChunkMarker(doc, 1)).toBe(false);
    expect(hasChunkMarker(doc, 10)).toBe(true);
  });
});

describe("readChunkBody", () => {
  it("reads the body of the requested chunk", () => {
    const doc = buildDocument(["first text", "second text"]);
    expect(readChunkBody(doc, 2)).toBe("second text");
  });

  it("reads a multi-line body", () => {
    const doc = buildDocument(["line one\n\nline two"]);
    expect(readChunkBody(doc, 1)).toBe("line one\n\nline two");
  });

  it("returns null when the chunk is absent", () => {
    expect(readChunkBody(buildDocument(["one"]), 5)).toBeNull();
  });

  it("reads an empty body", () => {
    expect(readChunkBody(wrapChunkBody(1, ""), 1)).toBe("");
  });
});

describe("replaceChunkBody", () => {
  it("replaces only the targeted chunk", () => {
    const doc = buildDocument(["one", "two", "three"]);
    const next = replaceChunkBody(doc, 2, "TWO");

    expect(next).not.toBeNull();
    expect(readChunkBody(next!, 1)).toBe("one");
    expect(readChunkBody(next!, 2)).toBe("TWO");
    expect(readChunkBody(next!, 3)).toBe("three");
  });

  it("preserves manual edits made to other chunks", () => {
    const edited = buildDocument(["hand-edited by user", "stale"]);
    const next = replaceChunkBody(edited, 2, "fresh");

    expect(readChunkBody(next!, 1)).toBe("hand-edited by user");
    expect(readChunkBody(next!, 2)).toBe("fresh");
  });

  it("keeps frontmatter and heading intact", () => {
    const doc = buildDocument(["one"]);
    const next = replaceChunkBody(doc, 1, "replaced");

    expect(next).toContain("audio: recordings/meeting.m4a");
    expect(next).toContain("## Transcription");
  });

  it("replaces a placeholder body with real text", () => {
    const doc = buildDocument(["{{CHUNK_PENDING:1}}"]);
    const next = replaceChunkBody(doc, 1, "transcribed text");

    expect(readChunkBody(next!, 1)).toBe("transcribed text");
    expect(next).not.toContain("{{CHUNK_PENDING:1}}");
  });

  it("does not expand $-sequences in the replacement text", () => {
    const doc = buildDocument(["placeholder"]);
    const tricky = "가격은 $& 이고 $` 와 $' 도 나옵니다";
    const next = replaceChunkBody(doc, 1, tricky);

    expect(readChunkBody(next!, 1)).toBe(tricky);
  });

  it("handles multi-line replacement text", () => {
    const doc = buildDocument(["placeholder", "other"]);
    const next = replaceChunkBody(doc, 1, "line one\n\nline two");

    expect(readChunkBody(next!, 1)).toBe("line one\n\nline two");
    expect(readChunkBody(next!, 2)).toBe("other");
  });

  it("returns null when the chunk markers are missing", () => {
    expect(replaceChunkBody("## Transcription\n\nplain\n", 1, "x")).toBeNull();
  });

  it("carries a 4-chunk document from placeholders to final text", () => {
    // Mirrors the real flow: temp file starts as wrapped PENDING placeholders,
    // chunks land out of order, then one chunk is re-run.
    let doc = buildDocument([
      "{{CHUNK_PENDING:1}}",
      "{{CHUNK_PENDING:2}}",
      "{{CHUNK_PENDING:3}}",
      "{{CHUNK_PENDING:4}}",
    ]);

    doc = replaceChunkBody(doc, 3, "third")!;
    doc = replaceChunkBody(doc, 1, "first")!;
    doc = replaceChunkBody(doc, 4, "{{CHUNK_FAILED:4}}")!;
    doc = replaceChunkBody(doc, 2, "second")!;

    expect(doc).not.toContain("{{CHUNK_PENDING:");
    expect(readChunkBody(doc, 4)).toBe("{{CHUNK_FAILED:4}}");

    // Failed chunk recovers, then chunk 2 is re-run from the log
    doc = replaceChunkBody(doc, 4, "fourth")!;
    doc = replaceChunkBody(doc, 2, "second, take two")!;

    expect(readChunkBody(doc, 1)).toBe("first");
    expect(readChunkBody(doc, 2)).toBe("second, take two");
    expect(readChunkBody(doc, 3)).toBe("third");
    expect(readChunkBody(doc, 4)).toBe("fourth");
    expect(doc).toContain("## Transcription");
  });

  it("survives repeated replacement of the same chunk", () => {
    const doc = buildDocument(["first"]);
    const once = replaceChunkBody(doc, 1, "second")!;
    const twice = replaceChunkBody(once, 1, "third")!;

    expect(readChunkBody(twice, 1)).toBe("third");
    expect(hasChunkMarker(twice, 1)).toBe(true);
  });
});

describe("failed chunks left in a finalized file", () => {
  it("can be located and replaced later", () => {
    // A run no longer blocks on failures: the file is finalized with FAILED
    // placeholders and each chunk is retried from the progress log.
    let doc = buildDocument(["one", "{{CHUNK_FAILED:2}}", "{{CHUNK_FAILED:3}}"]);

    expect(hasChunkMarker(doc, 2)).toBe(true);
    expect(hasChunkMarker(doc, 3)).toBe(true);

    // Retrying chunk 2 must not disturb chunk 3's placeholder
    doc = replaceChunkBody(doc, 2, "second")!;
    expect(readChunkBody(doc, 2)).toBe("second");
    expect(readChunkBody(doc, 3)).toBe("{{CHUNK_FAILED:3}}");

    doc = replaceChunkBody(doc, 3, "third")!;
    expect(readChunkBody(doc, 3)).toBe("third");
    expect(doc).not.toContain("{{CHUNK_FAILED:");
  });

  it("has its placeholders stripped when the transcript is reused", () => {
    // Mirrors findExistingTranscription: the summary must not receive them
    const doc = buildDocument(["one", "{{CHUNK_FAILED:2}}", "three"]);
    const reused = doc.replace(/\{\{CHUNK_FAILED:\d+\}\}/g, "").trim();

    expect(reused).not.toContain("CHUNK_FAILED");
    expect(reused).toContain("one");
    expect(reused).toContain("three");
    // Markers survive so retry still works on the file itself
    expect(hasChunkMarker(doc, 2)).toBe(true);
  });
});

describe("skipped chunk bodies", () => {
  it("can be replaced even though the body is itself a comment", () => {
    // Skip bodies are wrapped in %% so they stay out of the rendered note
    const skipBody = "%%[No speech detected — 59:35–1:15:29 skipped]%%";
    let doc = buildDocument(["spoken", skipBody]);

    expect(readChunkBody(doc, 2)).toBe(skipBody);

    // Retrying the skipped range must swap the whole comment for real text
    doc = replaceChunkBody(doc, 2, "turns out someone did talk here")!;
    expect(readChunkBody(doc, 2)).toBe("turns out someone did talk here");
    expect(doc).not.toContain("No speech detected");
    expect(readChunkBody(doc, 1)).toBe("spoken");
  });
});
