import { describe, it, expect } from "vitest";
import {
  analyzeSpeechActivity,
  findSpeechIslands,
  speechRatioInRange,
} from "../speechActivity";

const RATE = 16000;

/** Deterministic PRNG so noise-based assertions never flake. */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function toPcm16(values: number[]): Int16Array {
  const out = new Int16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(values[i] * 32767)));
  }
  return out;
}

/**
 * Voiced speech stand-in: low zero-crossing rate, but crucially *not* a flat
 * tone — real speech swings in energy every few frames as syllables and pauses
 * go by, and the adaptive noise floor depends on that swing.
 */
function speechLike(
  seconds: number,
  frequency = 200,
  amplitude = 0.5,
  rate = RATE
): number[] {
  const count = Math.floor(rate * seconds);
  const syllableSamples = Math.floor(rate * 0.28);
  const voicedSamples = Math.floor(rate * 0.2);
  const values: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const positionInSyllable = i % syllableSamples;
    if (positionInSyllable >= voicedSamples) {
      values[i] = 0; // inter-syllable pause
      continue;
    }
    // Taper each syllable so energy ramps rather than switching squarely
    const envelope = Math.sin((Math.PI * positionInSyllable) / voicedSamples);
    values[i] =
      amplitude * envelope * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return values;
}

/**
 * Pink-ish noise — the realistic stand-in for fans, HVAC and traffic. Low
 * frequencies dominate so it slips past the zero-crossing gate; only the pitch
 * stage rejects it.
 */
function pinkNoise(seconds: number, amplitude = 0.05, seed = 99): number[] {
  const random = createRandom(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return Array.from({ length: Math.floor(RATE * seconds) }, () => {
    const w = random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return amplitude * (b0 + b1 + b2 + w * 0.1848) * 0.3;
  });
}

/** Steady low-frequency hum: high energy, very low zero-crossing rate. */
function hum(seconds: number, amplitude = 0.05, frequency = 60): number[] {
  return Array.from(
    { length: Math.floor(RATE * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE)
  );
}

/** Broadband room noise: audible energy but very high zero-crossing rate. */
function noise(seconds: number, amplitude = 0.05, seed = 42): number[] {
  const random = createRandom(seed);
  const count = Math.floor(RATE * seconds);
  const values: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = amplitude * (random() * 2 - 1);
  }
  return values;
}

function silence(seconds: number): number[] {
  return new Array(Math.floor(RATE * seconds)).fill(0);
}

function analyze(values: number[]) {
  return analyzeSpeechActivity({
    samples: toPcm16(values),
    sampleRate: RATE,
    numChannels: 1,
  });
}

describe("analyzeSpeechActivity", () => {
  it("returns an empty result for empty input", () => {
    const result = analyzeSpeechActivity({
      samples: new Int16Array(0),
      sampleRate: RATE,
      numChannels: 1,
    });

    expect(result.buckets).toEqual([]);
    expect(result.speechRatio).toBe(0);
  });

  it("reports no speech for silence", () => {
    expect(analyze(silence(3)).speechRatio).toBe(0);
  });

  it("reports no speech for broadband noise", () => {
    // The whole point: noise has real energy, so an absolute RMS threshold
    // would call this speech.
    const result = analyze(noise(5));

    expect(result.peakRms).toBeGreaterThan(0);
    expect(result.speechRatio).toBeLessThan(0.05);
  });

  it("reports speech for a voiced-like signal", () => {
    // Not ~1.0: the inter-syllable pauses are correctly not counted as speech.
    expect(analyze(speechLike(3)).speechRatio).toBeGreaterThan(0.6);
  });

  it("still finds speech when it sits on top of noise", () => {
    const speech = speechLike(3);
    const bed = noise(3);
    expect(
      analyze(speech.map((v, i) => v + bed[i])).speechRatio
    ).toBeGreaterThan(0.6);
  });

  it("separates a talking stretch from a noise-only tail", () => {
    // The reported case: speech up front, noise-only for the final quarter.
    const result = analyze([...speechLike(6), ...noise(2)]);

    expect(speechRatioInRange(result, 0, 6000)).toBeGreaterThan(0.6);
    expect(speechRatioInRange(result, 6000, 8000)).toBeLessThan(0.1);
  });

  it("shows the same split in the sparkline buckets", () => {
    const result = analyze([...speechLike(6), ...noise(2)]);
    const mean = (values: number[]) =>
      values.reduce((sum, v) => sum + v, 0) / values.length;
    const firstHalf = result.buckets.slice(0, result.buckets.length / 2);
    const tail = result.buckets.slice(-8);

    expect(mean(firstHalf)).toBeGreaterThan(0.5);
    expect(mean(tail)).toBeLessThan(0.1);
  });

  it("keeps bucket values within 0..1", () => {
    for (const value of analyze([...speechLike(2), ...noise(2)]).buckets) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("caps bucket count at the number of frames for very short audio", () => {
    const result = analyze(speechLike(0.6));
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets.length).toBeLessThanOrEqual(120);
  });

  it("analyses only the first channel of interleaved stereo", () => {
    const left = speechLike(3);
    const interleaved: number[] = [];
    for (let i = 0; i < left.length; i++) {
      interleaved.push(left[i], 0); // right channel silent
    }

    const result = analyzeSpeechActivity({
      samples: toPcm16(interleaved),
      sampleRate: RATE,
      numChannels: 2,
    });

    expect(result.speechRatio).toBeGreaterThan(0.6);
  });

  it("handles a higher sample rate by decimating", () => {
    const rate = 48000;
    const result = analyzeSpeechActivity({
      samples: toPcm16(speechLike(3, 200, 0.5, rate)),
      sampleRate: rate,
      numChannels: 1,
    });

    expect(result.speechRatio).toBeGreaterThan(0.6);
  });

  it("maps ranges onto the right part of the timeline", () => {
    const result = analyze([...noise(2), ...speechLike(2), ...noise(2)]);

    expect(speechRatioInRange(result, 0, 2000)).toBeLessThan(0.1);
    expect(speechRatioInRange(result, 2000, 4000)).toBeGreaterThan(0.6);
    expect(speechRatioInRange(result, 4000, 6000)).toBeLessThan(0.1);
  });
});

describe("analyzeSpeechActivity — pitch gate", () => {
  // Without the pitch stage these two score 12–100% "speech", overlapping
  // sparse real speech and making any threshold useless.
  it("rejects pink noise, which slips past the zero-crossing gate", () => {
    const result = analyze([...speechLike(6), ...pinkNoise(2)]);
    expect(speechRatioInRange(result, 6000, 8000)).toBeLessThan(0.02);
  });

  it("rejects steady low-frequency hum", () => {
    const result = analyze([...speechLike(6), ...hum(2)]);
    expect(speechRatioInRange(result, 6000, 8000)).toBeLessThan(0.02);
  });

  it("keeps quiet speech that sits on a pink-noise bed", () => {
    const quiet = speechLike(3, 200, 0.08);
    const bed = pinkNoise(3, 0.03);
    const result = analyze([
      ...speechLike(4),
      ...quiet.map((v, i) => v + bed[i]),
    ]);
    expect(speechRatioInRange(result, 4000, 7000)).toBeGreaterThan(0.5);
  });
});

describe("findSpeechIslands", () => {
  const opts = { minGapMs: 2000, paddingMs: 300, minIslandSpeechMs: 300 };

  it("returns nothing when there is no speech at all", () => {
    expect(findSpeechIslands(analyze(pinkNoise(4)), 4000, opts)).toEqual([]);
  });

  it("returns a single island for speech followed by silence", () => {
    // The trailing-silence case: one island means a plain trim
    const result = analyze([...speechLike(4), ...pinkNoise(4)]);
    const islands = findSpeechIslands(result, 8000, opts);

    expect(islands).toHaveLength(1);
    expect(islands[0].startMs).toBe(0);
    expect(islands[0].endMs).toBeGreaterThan(3500);
    expect(islands[0].endMs).toBeLessThan(5000);
  });

  it("splits speech separated by a long silence", () => {
    // The stray-late-remark case: 4s speech, 6s quiet, 1s speech
    const result = analyze([
      ...speechLike(4),
      ...pinkNoise(6),
      ...speechLike(1),
    ]);
    const islands = findSpeechIslands(result, 11000, opts);

    expect(islands).toHaveLength(2);
    expect(islands[0].startMs).toBe(0);
    expect(islands[1].endMs).toBe(11000);
    // The gap between them is what gets skipped
    expect(islands[1].startMs - islands[0].endMs).toBeGreaterThan(4000);
  });

  it("keeps a short pause inside one island", () => {
    const result = analyze([
      ...speechLike(3),
      ...pinkNoise(1),
      ...speechLike(3),
    ]);
    expect(findSpeechIslands(result, 7000, opts)).toHaveLength(1);
  });

  it("ignores an isolated blip that carries almost no speech", () => {
    const result = analyze([
      ...speechLike(4),
      ...pinkNoise(4),
      ...speechLike(0.1),
      ...pinkNoise(3),
    ]);
    const islands = findSpeechIslands(result, 11100, {
      ...opts,
      minIslandSpeechMs: 800,
    });
    expect(islands).toHaveLength(1);
  });

  it("pads islands without running past the file bounds", () => {
    const result = analyze([...pinkNoise(3), ...speechLike(3)]);
    const islands = findSpeechIslands(result, 6000, opts);

    expect(islands).toHaveLength(1);
    expect(islands[0].startMs).toBeGreaterThanOrEqual(0);
    expect(islands[0].endMs).toBeLessThanOrEqual(6000);
    // Padding pulls the start earlier than the first speech frame
    expect(islands[0].startMs).toBeLessThan(3000);
  });
});

describe("minimum speech run", () => {
  it("does not count an isolated blip as speech", () => {
    // 40ms tone inside otherwise quiet noise — shorter than any syllable
    const bed = pinkNoise(3);
    const blipAt = Math.floor(RATE * 1.5);
    for (let i = 0; i < Math.floor(RATE * 0.04); i++) {
      bed[blipAt + i] += 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE);
    }
    expect(analyze([...speechLike(4), ...bed]).speechRatio).toBeLessThan(0.45);
    expect(speechRatioInRange(analyze([...speechLike(4), ...bed]), 4000, 7000))
      .toBeLessThan(0.02);
  });

  it("still splits islands when the quiet tail carries periodic blips", () => {
    // Regression: one stray frame every few seconds reads as 0% speech but
    // kept resetting the silence run, so nothing was ever skipped.
    const tail = pinkNoise(9);
    for (let t = 0; t < 9; t += 1.5) {
      const at = Math.floor(RATE * t);
      for (let i = 0; i < Math.floor(RATE * 0.04); i++) {
        tail[at + i] += 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE);
      }
    }
    const result = analyze([...speechLike(4), ...tail]);
    const islands = findSpeechIslands(result, 13000, {
      minGapMs: 2000,
      paddingMs: 300,
      minIslandSpeechMs: 300,
    });

    expect(islands).toHaveLength(1);
    expect(islands[0].endMs).toBeLessThan(6000);
  });

  it("keeps speech whose voiced runs are only ~200ms", () => {
    // Guard against over-filtering: a 300ms cut erased ordinary speech
    expect(analyze(speechLike(3)).speechRatio).toBeGreaterThan(0.5);
  });
});
