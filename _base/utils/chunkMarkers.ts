/**
 * Chunk boundary markers written into the transcription file.
 *
 * Each chunk's text is wrapped in Obsidian comments (`%%...%%`, invisible in
 * reading view) so that a single chunk can be located and replaced later —
 * after the placeholder that originally marked its slot is long gone. The
 * markers are written when the temp file is created and are never removed,
 * which is what makes per-chunk retry possible once a chunk has succeeded.
 */

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
