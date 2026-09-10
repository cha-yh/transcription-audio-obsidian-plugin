/**
 * Chunk boundary markers written into the transcription file.
 *
 * Each chunk's text is wrapped in Obsidian comments (`%%...%%`, invisible in
 * reading view) so that a single chunk can be located and replaced later —
 * after the placeholder that originally marked its slot is long gone. The
 * markers are written when the temp file is created and are never removed,
 * which is what makes per-chunk retry possible once a chunk has succeeded.
 */

/**
 * Placeholders standing in for a chunk that has not produced text yet, or that
 * failed. Both are marker syntax, so `stripChunkMarkers` owns removing them.
 */
export const CHUNK_PENDING_PREFIX = "{{CHUNK_PENDING:";
export const CHUNK_FAILED_PREFIX = "{{CHUNK_FAILED:";
export const CHUNK_PLACEHOLDER_SUFFIX = "}}";

function chunkBodyPattern(chunkIndex: number): RegExp {
  return new RegExp(
    `(%%chunk:${chunkIndex}%%\\n)([\\s\\S]*?)(\\n%%/chunk:${chunkIndex}%%)`
  );
}

export function wrapChunkBody(chunkIndex: number, body: string): string {
  return `%%chunk:${chunkIndex}%%\n${body}\n%%/chunk:${chunkIndex}%%`;
}

export function hasChunkMarker(data: string, chunkIndex: number): boolean {
  return chunkBodyPattern(chunkIndex).test(data);
}

export function readChunkBody(
  data: string,
  chunkIndex: number
): string | null {
  const match = data.match(chunkBodyPattern(chunkIndex));
  return match ? match[2] : null;
}

/**
 * Replaces only the text between chunk `chunkIndex`'s markers, leaving every
 * other chunk — and any manual edit the user made to them — untouched.
 * Returns null when the markers are absent (e.g. a transcription file created
 * before markers existed), so callers can refuse the retry instead of
 * corrupting the file.
 *
 * The replacement is applied through a callback: transcript text can contain
 * `$&` or `` $` ``, which a string replacement would expand.
 */
export function replaceChunkBody(
  data: string,
  chunkIndex: number,
  newBody: string
): string | null {
  const pattern = chunkBodyPattern(chunkIndex);
  if (!pattern.test(data)) {
    return null;
  }
  return data.replace(pattern, (_match, open: string, _body, close: string) =>
    `${open}${newBody}${close}`
  );
}

/**
 * Removes the marker syntax — chunk boundaries, skip notes and the pending and
 * failed placeholders — from a transcription file's body, leaving only the
 * speech. The markers stay in the file — they are what makes per-chunk retry
 * possible — but they are noise, and billed tokens, when a stored transcript is
 * handed back to the model for classification or summarization.
 */
export function stripChunkMarkers(data: string): string {
  return data
    .replace(/^%%\/?chunk:\d+%%\n?/gm, "")
    .replace(/^%%\[No speech detected[^\]]*\]%%\n?/gm, "")
    .replace(/\{\{CHUNK_(?:PENDING|FAILED):\d+\}\}\n?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
