export type ChunkRange = { startMs: number; endMs: number };

/** A trailing chunk shorter than this is folded into its predecessor. */
const MIN_TAIL_CHUNK_MS = 2 * 60 * 1000;

export function computeTimeBasedChunkRanges(params: {
  totalMs: number;
  chunkDurationMs?: number;
  overlapMs?: number;
  minTailMs?: number;
}): ChunkRange[] {
  const chunkDurationMs = params.chunkDurationMs ?? 20 * 60 * 1000;
  const overlapMs = params.overlapMs ?? 1500;
  const minTailMs = params.minTailMs ?? MIN_TAIL_CHUNK_MS;

  const chunks: ChunkRange[] = [];
  let cursor = 0;
  while (cursor < params.totalMs) {
    const startMs = cursor;
    const endMs = Math.min(params.totalMs, startMs + chunkDurationMs);
    chunks.push({ startMs, endMs });
    if (endMs >= params.totalMs) break;
    cursor = endMs - overlapMs;
  }

  // Each chunk starts `overlapMs` before the previous one ended, so a duration
  // near a multiple of chunkDurationMs leaves a sliver at the end — a 60-minute
  // file otherwise finishes with a 4.5-second chunk that costs a whole request
  // and returns nothing useful. Fold it back instead.
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1];
    if (tail.endMs - tail.startMs < minTailMs) {
      chunks.pop();
      chunks[chunks.length - 1].endMs = tail.endMs;
    }
  }

  return chunks;
}

export type PlannedChunk = ChunkRange & {
  /** True when the range holds no speech and is not sent to the model. */
  skipped: boolean;
};

/**
 * Chunks each speech island independently and records the silence between
 * them as skipped ranges.
 *
 * Chunking the file end-to-end sends every quiet minute to the model, which
 * costs upload time and invites hallucinated transcript. Trimming to the last
 * speech instead fails whenever a single late remark follows a long silence —
 * one stray word keeps the whole gap alive. Planning per island handles both:
 * a file with one island reduces to a plain trim.
 *
 * Skipped ranges stay in the returned list and keep their position, so chunk
 * numbering, file markers, and per-chunk retry all line up with what the user
 * sees.
 */
export function computeSpeechAwareChunkPlan(params: {
  totalMs: number;
  islands: ChunkRange[];
  chunkDurationMs?: number;
  overlapMs?: number;
}): PlannedChunk[] {
  const chunkDurationMs = params.chunkDurationMs ?? 20 * 60 * 1000;
  const overlapMs = params.overlapMs ?? 1500;

  // No detected speech: fall back to the whole file rather than skip everything
  const islands =
    params.islands.length > 0
      ? [...params.islands].sort((a, b) => a.startMs - b.startMs)
      : [{ startMs: 0, endMs: params.totalMs }];

  const plan: PlannedChunk[] = [];
  let cursor = 0;

  for (const island of islands) {
    const startMs = Math.max(cursor, Math.max(0, island.startMs));
    const endMs = Math.min(params.totalMs, island.endMs);
    if (endMs <= startMs) continue;

    if (startMs > cursor) {
      plan.push({ startMs: cursor, endMs: startMs, skipped: true });
    }

    for (const range of computeTimeBasedChunkRanges({
      totalMs: endMs - startMs,
      chunkDurationMs,
      overlapMs,
    })) {
      plan.push({
        startMs: startMs + range.startMs,
        endMs: startMs + range.endMs,
        skipped: false,
      });
    }

    cursor = endMs;
  }

  if (cursor < params.totalMs) {
    plan.push({ startMs: cursor, endMs: params.totalMs, skipped: true });
  }

  return plan;
}

export function computeWavChunkRanges(params: {
  dataSize: number;
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
  targetChunkMB?: number; // default 10
  overlapMs?: number; // default 2000
}): ChunkRange[] {
  const targetChunkMB = params.targetChunkMB ?? 10;
  const overlapMs = params.overlapMs ?? 2000;

  const bytesPerSample = params.bitsPerSample / 8;
  const bytesPerFrame = params.numChannels * bytesPerSample;
  const totalFrames = Math.floor(params.dataSize / bytesPerFrame);
  const totalMs = Math.floor((totalFrames / params.sampleRate) * 1000);

  const targetBytes = targetChunkMB * 1024 * 1024;
  // Approximate chunk length: keep within 2–8 minutes for stability
  let approxChunkMs = Math.max(
    30_000,
    Math.floor((targetBytes / Math.max(1, params.dataSize)) * totalMs)
  );
  approxChunkMs = Math.max(120_000, Math.min(480_000, approxChunkMs));

  const chunks: ChunkRange[] = [];
  let cursor = 0;
  while (cursor < totalMs) {
    const startMs = cursor;
    const endMs = Math.min(totalMs, startMs + approxChunkMs);
    chunks.push({ startMs, endMs });
    if (endMs >= totalMs) break;
    cursor = endMs - overlapMs;
  }

  return chunks;
}
