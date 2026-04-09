import { describe, it, expect } from "vitest";
import {
  computeTimeBasedChunkRanges,
  computeWavChunkRanges,
} from "../chunking";

describe("computeTimeBasedChunkRanges", () => {
  it("returns a single chunk for audio under 20 minutes", () => {
    const chunks = computeTimeBasedChunkRanges({ totalMs: 15 * 60 * 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startMs: 0, endMs: 15 * 60 * 1000 });
  });

  it("returns a single chunk for exactly 20 minutes", () => {
    const chunks = computeTimeBasedChunkRanges({ totalMs: 20 * 60 * 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endMs).toBe(20 * 60 * 1000);
  });

  it("returns multiple chunks for 1 hour with overlap", () => {
    const totalMs = 60 * 60 * 1000;
    const chunks = computeTimeBasedChunkRanges({ totalMs });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Last chunk must reach the end
    expect(chunks[chunks.length - 1].endMs).toBe(totalMs);
  });

  it("applies overlap between consecutive chunks", () => {
    const totalMs = 60 * 60 * 1000;
    const overlapMs = 1500;
    const chunks = computeTimeBasedChunkRanges({ totalMs, overlapMs });
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1].endMs;
      const currStart = chunks[i].startMs;
      expect(currStart).toBe(prevEnd - overlapMs);
    }
  });

  it("returns chunks for 2 hours", () => {
    const totalMs = 2 * 60 * 60 * 1000;
    const chunks = computeTimeBasedChunkRanges({ totalMs });
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    expect(chunks[chunks.length - 1].endMs).toBe(totalMs);
  });

  it("uses custom chunkDurationMs", () => {
    const totalMs = 60 * 60 * 1000;
    const chunks = computeTimeBasedChunkRanges({
      totalMs,
      chunkDurationMs: 10 * 60 * 1000,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(6);
  });

  it("defaults to 20min chunks and 1500ms overlap", () => {
    const totalMs = 41 * 60 * 1000; // 41 minutes
    const chunks = computeTimeBasedChunkRanges({ totalMs });
    // First chunk: 0-20min, second starts at 20min-1.5s
    expect(chunks[0].endMs).toBe(20 * 60 * 1000);
    expect(chunks[1].startMs).toBe(20 * 60 * 1000 - 1500);
  });

  it("handles zero totalMs", () => {
    const chunks = computeTimeBasedChunkRanges({ totalMs: 0 });
    expect(chunks).toHaveLength(0);
  });
});

describe("computeWavChunkRanges", () => {
  const baseParams = {
    sampleRate: 16000,
    bitsPerSample: 16,
    numChannels: 1,
  };

  it("returns a single chunk for a small file", () => {
    // 1 minute of 16kHz mono 16-bit = ~1.92 MB
    const durationMs = 60 * 1000;
    const dataSize = (durationMs / 1000) * 16000 * 2;
    const chunks = computeWavChunkRanges({ ...baseParams, dataSize });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startMs).toBe(0);
  });

  it("returns multiple chunks for a large file", () => {
    // 60 minutes of 16kHz mono 16-bit = ~115 MB
    const durationMs = 60 * 60 * 1000;
    const dataSize = (durationMs / 1000) * 16000 * 2;
    const chunks = computeWavChunkRanges({ ...baseParams, dataSize });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].endMs).toBe(durationMs);
  });

  it("clamps chunk length to 2-8 minute range", () => {
    const durationMs = 60 * 60 * 1000;
    const dataSize = (durationMs / 1000) * 16000 * 2;
    const chunks = computeWavChunkRanges({ ...baseParams, dataSize });
    for (const c of chunks) {
      const chunkDuration = c.endMs - c.startMs;
      // Last chunk can be shorter
      if (c !== chunks[chunks.length - 1]) {
        expect(chunkDuration).toBeGreaterThanOrEqual(120_000);
        expect(chunkDuration).toBeLessThanOrEqual(480_000);
      }
    }
  });

  it("applies overlap between chunks", () => {
    const durationMs = 60 * 60 * 1000;
    const dataSize = (durationMs / 1000) * 16000 * 2;
    const overlapMs = 2000;
    const chunks = computeWavChunkRanges({
      ...baseParams,
      dataSize,
      overlapMs,
    });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startMs).toBe(chunks[i - 1].endMs - overlapMs);
    }
  });

  it("last chunk reaches end", () => {
    const durationMs = 30 * 60 * 1000;
    const dataSize = (durationMs / 1000) * 16000 * 2;
    const chunks = computeWavChunkRanges({ ...baseParams, dataSize });
    expect(chunks[chunks.length - 1].endMs).toBe(durationMs);
  });
});
