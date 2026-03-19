export type ChunkRange = { startMs: number; endMs: number };

export function computeTimeBasedChunkRanges(params: {
  totalMs: number;
  chunkDurationMs?: number;
  overlapMs?: number;
}): ChunkRange[] {
  const chunkDurationMs = params.chunkDurationMs ?? 20 * 60 * 1000;
  const overlapMs = params.overlapMs ?? 1500;

  const chunks: ChunkRange[] = [];
  let cursor = 0;
  while (cursor < params.totalMs) {
    const startMs = cursor;
    const endMs = Math.min(params.totalMs, startMs + chunkDurationMs);
    chunks.push({ startMs, endMs });
    if (endMs >= params.totalMs) break;
    cursor = endMs - overlapMs;
  }

  return chunks;
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
