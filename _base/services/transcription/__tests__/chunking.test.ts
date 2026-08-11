import { describe, it, expect } from "vitest";
import type { PlannedChunk } from "../chunking";
import {
  computeSpeechAwareChunkPlan,
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

  it("folds a sliver tail into the previous chunk", () => {
    // 60 minutes lands just past three 20-minute chunks, leaving 4.5s over
    const chunks = computeTimeBasedChunkRanges({ totalMs: 60 * 60 * 1000 });

    expect(chunks).toHaveLength(3);
    expect(chunks[2].endMs).toBe(60 * 60 * 1000);
    for (const chunk of chunks) {
      expect(chunk.endMs - chunk.startMs).toBeGreaterThan(2 * 60 * 1000);
    }
  });

  it("keeps a trailing chunk that is long enough to stand alone", () => {
    // 75 minutes ends with a genuine 15-minute chunk
    const chunks = computeTimeBasedChunkRanges({ totalMs: 75 * 60 * 1000 });

    expect(chunks).toHaveLength(4);
    expect(chunks[3].endMs - chunks[3].startMs).toBeGreaterThan(15 * 60 * 1000 - 1000);
  });

  it("never folds away the only chunk", () => {
    const chunks = computeTimeBasedChunkRanges({ totalMs: 5000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startMs: 0, endMs: 5000 });
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

describe("computeSpeechAwareChunkPlan", () => {
  const M = 60 * 1000;
  const sent = (plan: PlannedChunk[]) => plan.filter((c) => !c.skipped);
  const skipped = (plan: PlannedChunk[]) => plan.filter((c) => c.skipped);

  it("falls back to the whole file when no speech was detected", () => {
    // Skipping everything on a failed analysis would lose the recording
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 75 * M,
      islands: [],
    });

    expect(skipped(plan)).toHaveLength(0);
    expect(sent(plan)).toHaveLength(4);
    expect(plan[0].startMs).toBe(0);
    expect(plan[plan.length - 1].endMs).toBe(75 * M);
  });

  it("reduces to a plain trim when there is one island", () => {
    // 75 minutes of audio, speech ends at 50 → the 20/20/10 split
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 75 * M,
      islands: [{ startMs: 0, endMs: 50 * M }],
    });

    expect(sent(plan)).toHaveLength(3);
    expect(sent(plan)[2].endMs).toBe(50 * M);
    expect(skipped(plan)).toHaveLength(1);
    expect(skipped(plan)[0]).toEqual({
      startMs: 50 * M,
      endMs: 75 * M,
      skipped: true,
    });
  });

  it("keeps a late remark that follows a long silence", () => {
    // One stray island at the end must not drag the whole gap along
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 75 * M,
      islands: [
        { startMs: 0, endMs: 53 * M },
        { startMs: 73.75 * M, endMs: 75 * M },
      ],
    });

    expect(sent(plan)).toHaveLength(4);
    expect(sent(plan)[3]).toEqual({
      startMs: 73.75 * M,
      endMs: 75 * M,
      skipped: false,
    });
    expect(skipped(plan)).toHaveLength(1);
    expect(skipped(plan)[0].startMs).toBe(53 * M);
    expect(skipped(plan)[0].endMs).toBe(73.75 * M);
  });

  it("records a skipped range before a late-starting island", () => {
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 30 * M,
      islands: [{ startMs: 10 * M, endMs: 30 * M }],
    });

    expect(plan[0]).toEqual({ startMs: 0, endMs: 10 * M, skipped: true });
    expect(sent(plan)[0].startMs).toBe(10 * M);
  });

  it("covers the timeline with no gaps or overlaps between entries", () => {
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 75 * M,
      islands: [
        { startMs: 5 * M, endMs: 25 * M },
        { startMs: 40 * M, endMs: 60 * M },
      ],
    });

    expect(plan[0].startMs).toBe(0);
    expect(plan[plan.length - 1].endMs).toBe(75 * M);
    // Sent chunks may overlap by design; boundaries must never move backwards
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].startMs).toBeLessThanOrEqual(plan[i - 1].endMs);
      expect(plan[i].endMs).toBeGreaterThan(plan[i - 1].startMs);
    }
  });

  it("sorts islands that arrive out of order", () => {
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 40 * M,
      islands: [
        { startMs: 30 * M, endMs: 40 * M },
        { startMs: 0, endMs: 10 * M },
      ],
    });

    expect(sent(plan)[0].startMs).toBe(0);
    expect(sent(plan)[1].startMs).toBe(30 * M);
  });

  it("clamps islands that run past the end of the file", () => {
    const plan = computeSpeechAwareChunkPlan({
      totalMs: 10 * M,
      islands: [{ startMs: 0, endMs: 99 * M }],
    });

    expect(plan[plan.length - 1].endMs).toBe(10 * M);
  });
});
