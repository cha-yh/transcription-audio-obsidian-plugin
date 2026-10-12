/**
 * Names and contents of the summary file written next to a transcript. Pure,
 * so the naming and the heading rules can be tested without a vault.
 */
import { stripChunkMarkers } from "./chunkMarkers";

const TRANSCRIPT_PREFIX = "_transcription_";
const SUMMARY_PREFIX = "_summary_";
/** The heading a note embeds, as in `![[_summary_x#Summary]]`. */
export const SUMMARY_HEADING = "Summary";
/** "2026-10-12T00-23-21", the stamp both file kinds end with. */
const STAMP_PATTERN = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/** Same stamp the transcript file uses, so the two sort and read alike. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash >= 0
    ? { dir: path.slice(0, slash), name: path.slice(slash + 1) }
    : { dir: "", name: path };
}

const TRANSCRIPT_BODY_MARKER = "## Transcription\n\n";

/**
 * The transcript text of a transcript file, as the model should see it: what
 * follows the Transcription heading, without the chunk markers kept for
 * retries. Empty when the file has no such section.
 */
export function readTranscriptBody(content: string): string {
  const index = content.indexOf(TRANSCRIPT_BODY_MARKER);
  if (index === -1) return "";
  return stripChunkMarkers(
    content.substring(index + TRANSCRIPT_BODY_MARKER.length)
  );
}

/** A finished transcript file, not one still being written. */
export function isTranscriptFileName(name: string): boolean {
  return (
    name.startsWith(TRANSCRIPT_PREFIX) &&
    name.endsWith(".md") &&
    !name.endsWith("_temp.md")
  );
}

const WIKI_LINK = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MARKDOWN_LINK = /\[[^\]\n]*\]\(<?([^)>\n]+)>?\)/g;

/**
 * The transcript link a note's summarize command should use: the last one
 * before the cursor, like the audio link of a transcription, or else the first
 * one in the note. `end` is where the link stops, so the embed can go under
 * its line. Only the link text is checked here; the caller resolves it.
 */
export function pickTranscriptLink(
  text: string,
  cursorOffset: number
): { linkpath: string; end: number } | null {
  const links: { linkpath: string; end: number }[] = [];
  for (const pattern of [WIKI_LINK, MARKDOWN_LINK]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      let linkpath = match[1].trim();
      try {
        linkpath = decodeURI(linkpath);
      } catch {
        // Keep the raw text; a stray % is not worth losing the link over
      }
      const name = linkpath.split("/").pop() ?? "";
      if (!name.startsWith(TRANSCRIPT_PREFIX) || /_temp(\.md)?$/.test(name)) {
        continue;
      }
      links.push({ linkpath, end: match.index + match[0].length });
    }
  }
  if (links.length === 0) return null;
  links.sort((a, b) => a.end - b.end);
  const before = links.filter((link) => link.end <= cursorOffset);
  return before.length > 0 ? before[before.length - 1] : links[0];
}

/**
 * The audio name a transcript file was named after, e.g. "Recording 1" for
 * `_transcription_Recording 1_2026-10-12T00-23-21.md`.
 */
export function audioNameOfTranscript(transcriptPath: string): string {
  const base = splitPath(transcriptPath).name.replace(/\.md$/, "");
  const withoutPrefix = base.startsWith(TRANSCRIPT_PREFIX)
    ? base.slice(TRANSCRIPT_PREFIX.length)
    : base;
  return withoutPrefix.replace(STAMP_PATTERN, "") || "audio";
}

/** `_summary_<audio>_<stamp>.md` in the transcript's folder. */
export function summaryFilePath(transcriptPath: string, date: Date): string {
  const { dir } = splitPath(transcriptPath);
  const name = `${SUMMARY_PREFIX}${audioNameOfTranscript(
    transcriptPath
  )}_${fileTimestamp(date)}.md`;
  return dir ? `${dir}/${name}` : name;
}

/** The line a note gets under the transcript link. */
export function summaryEmbed(summaryPath: string): string {
  const base = splitPath(summaryPath).name.replace(/\.md$/, "");
  return `![[${base}#${SUMMARY_HEADING}]]`;
}

/**
 * Pushes the model's headings below the Summary heading. A heading embed ends
 * at the next heading of the same or a higher level, so a summary that opens
 * with its own `#` would otherwise be cut off right there in the note. Only
 * shifts when needed, keeping the relative levels; fenced code is left alone.
 */
export function nestHeadingsUnder(text: string, parentLevel: number): string {
  const lines = text.split("\n");
  let inFence = false;
  let minLevel = Infinity;
  const isHeading: (number | null)[] = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return null;
    }
    if (inFence) return null;
    const match = line.match(/^(#{1,6})\s/);
    if (!match) return null;
    minLevel = Math.min(minLevel, match[1].length);
    return match[1].length;
  });

  const shift = minLevel <= parentLevel ? parentLevel + 1 - minLevel : 0;
  if (shift === 0) return text;

  return lines
    .map((line, index) => {
      const level = isHeading[index];
      if (level === null) return line;
      const nextLevel = Math.min(6, level + shift);
      return "#".repeat(nextLevel) + line.slice(level);
    })
    .join("\n");
}

/**
 * Body of a summary file. The frontmatter mirrors the transcript's, and the
 * JSON-quoted values stay valid YAML for any path or category text.
 */
export function buildSummaryContent(params: {
  transcriptPath: string;
  audioPath?: string;
  category?: string;
  summary: string;
  createdAt: Date;
}): string {
  const transcriptName = splitPath(params.transcriptPath).name.replace(
    /\.md$/,
    ""
  );
  const lines = ["---", `transcript: ${JSON.stringify(`[[${transcriptName}]]`)}`];
  if (params.audioPath) lines.push(`audio: ${JSON.stringify(params.audioPath)}`);
  if (params.category) {
    lines.push(`category: ${JSON.stringify(params.category)}`);
  }
  lines.push(`created: ${params.createdAt.toISOString()}`, "---", "");
  return `${lines.join("\n")}\n# ${SUMMARY_HEADING}\n\n${nestHeadingsUnder(
    params.summary.trim(),
    1
  )}\n`;
}
