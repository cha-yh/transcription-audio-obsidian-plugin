/**
 * Voice-activity estimate over PCM samples.
 *
 * The job is separating speech from *noise*, not from silence: a room fan or
 * mic hiss carries far more energy than true silence, so an absolute RMS
 * threshold happily passes a 15-minute stretch of hum. Three signals decide:
 *
 *  - energy, measured against an adaptive noise floor
 *  - zero-crossing rate, low for voiced speech and high for hiss
 *  - autocorrelation pitch strength, which only vocal-cord periodicity produces
 *
 * The pitch stage is what makes the result usable. Measured on synthetic
 * signals, RMS+ZCR alone reports 12–100% "speech" for pink noise and low
 * frequency hum — overlapping the 11.9% that sparse real speech scores, so no
 * threshold can separate them. Adding pitch drops every noise type to 0.0%
 * while speech keeps 64–72%.
 *
 * Caveat: the adaptive floor assumes the recording varies over time. A
 * perfectly steady signal makes the 10th-percentile floor equal the signal
 * itself. Real speech swings at 30ms resolution so this holds in practice.
 *
 * Thresholds are starting values tuned against synthetic signals; re-check
 * them against real recordings.
 */

const FRAME_MS = 30;
/** Analysis is decimated to roughly this rate so cost is independent of source rate. */
const TARGET_ANALYSIS_RATE = 16000;
/** Quietest 10% of frames are assumed to be background. */
const NOISE_FLOOR_PERCENTILE = 0.1;
/** How far above the noise floor a frame must sit to count as speech. */
const SPEECH_RMS_MULTIPLIER = 2.5;
/** Absolute floor, so a near-silent file cannot make everything "speech". */
const MIN_SPEECH_RMS = 0.005;
/** Voiced speech crosses zero far less often than hiss does. */
const MAX_SPEECH_ZCR = 0.35;
/**
 * Shortest run of frames that can count as speech.
 *
 * An isolated frame or two is a stray detection, not a word. Left in, those
 * strays are ruinous: one false frame every 30 seconds reads as 0% speech yet
 * keeps resetting the silence run, so a 15-minute quiet tail never separates
 * into its own island and nothing gets skipped.
 *
 * Kept at 150ms rather than a full syllable: voiced runs break at unvoiced
 * consonants, and cutting at 300ms erased ordinary speech outright.
 */
const MIN_SPEECH_RUN_MS = 150;
/**
 * Normalized autocorrelation peak required to call a frame voiced. Speech
 * measures ~0.87; the worst noise offender (steady hum) tops out near 0.60.
 */
const MIN_PITCH_STRENGTH = 0.7;
/** Human pitch range searched by the autocorrelation. */
const MIN_PITCH_HZ = 80;
const MAX_PITCH_HZ = 400;
const DEFAULT_BUCKET_COUNT = 120;

/** Silence shorter than this stays inside a chunk rather than splitting it. */
export const MIN_SILENCE_GAP_MS = 5 * 60 * 1000;
/** Breathing room kept around each island so words are not clipped. */
export const ISLAND_PADDING_MS = 30 * 1000;
/** An island needs at least this much actual speech; guards against a lone cough. */
export const MIN_ISLAND_SPEECH_MS = 1000;

export type SpeechActivityResult = {
  /** Speech-frame ratio per bucket across the whole file, 0..1. */
  buckets: number[];
  /** Overall speech-frame ratio, 0..1. */
  speechRatio: number;
  noiseFloor: number;
  peakRms: number;
  /** Duration each frame covers, in milliseconds. */
  frameMs: number;
  /** Per-frame speech flags; ranges and islands are derived from these. */
  frames: Uint8Array;
};

function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * fraction))
  );
  return sorted[index];
}

/**
 * Normalized autocorrelation peak within the human pitch range.
 *
 * The frame is decimated by two before searching — pitch lives below 400Hz, so
 * half the rate is plenty and it cuts the inner loop cost fourfold.
 */
function pitchStrength(
  frame: Float64Array,
  length: number,
  rate: number,
  buf: Float64Array
): number {
  const n = Math.floor(length / 2);
  if (n < 8) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) {
    buf[i] = frame[i * 2];
    mean += buf[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) buf[i] -= mean;

  let energy = 0;
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
  if (energy < 1e-12) return 0;

  const halfRate = rate / 2;
  const minLag = Math.max(2, Math.floor(halfRate / MAX_PITCH_HZ));
  const maxLag = Math.min(n - 2, Math.floor(halfRate / MIN_PITCH_HZ));

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let lagEnergy = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += buf[i] * buf[i + lag];
      lagEnergy += buf[i + lag] * buf[i + lag];
    }
    const denom = Math.sqrt(energy * lagEnergy);
    if (denom < 1e-12) continue;
    const value = dot / denom;
    if (value > best) best = value;
  }
  return best;
}

/**
 * @param samples Interleaved PCM16. Only the first channel is analysed.
 */
export function analyzeSpeechActivity(params: {
  samples: Int16Array;
  sampleRate: number;
  numChannels: number;
  bucketCount?: number;
}): SpeechActivityResult {
  const { samples, sampleRate, numChannels } = params;
  const bucketCount = params.bucketCount ?? DEFAULT_BUCKET_COUNT;

  const empty: SpeechActivityResult = {
    buckets: [],
    speechRatio: 0,
    noiseFloor: 0,
    peakRms: 0,
    frameMs: FRAME_MS,
    frames: new Uint8Array(0),
  };

  if (
    samples.length === 0 ||
    sampleRate <= 0 ||
    numChannels <= 0 ||
    !Number.isFinite(sampleRate)
  ) {
    return empty;
  }

  // Decimate to ~16kHz so a 44.1kHz stereo file costs the same as 16kHz mono.
  // Skipping the anti-alias filter folds high frequencies down, acceptable for
  // a relative speech/noise decision.
  const stride = Math.max(1, Math.floor(sampleRate / TARGET_ANALYSIS_RATE));
  const analysisRate = sampleRate / stride;
  const frameLength = Math.max(2, Math.round((analysisRate * FRAME_MS) / 1000));

  const totalSourceFrames = Math.floor(samples.length / numChannels);
  const analysedSamples = Math.floor(totalSourceFrames / stride);
  const frameCount = Math.floor(analysedSamples / frameLength);
  if (frameCount === 0) {
    return empty;
  }

  const rms = new Float64Array(frameCount);
  const zcr = new Float64Array(frameCount);

  // Pass 1: energy and zero-crossings. Frame samples are deliberately not
  // retained — keeping every frame buffer for a 75-minute file would cost
  // hundreds of megabytes.
  for (let f = 0; f < frameCount; f++) {
    let sumSquares = 0;
    let crossings = 0;
    let previous = 0;

    for (let i = 0; i < frameLength; i++) {
      const sourceIndex = (f * frameLength + i) * stride * numChannels;
      const value = samples[sourceIndex] / 32768;
      sumSquares += value * value;
      if (i > 0 && (value >= 0 ? 1 : -1) !== (previous >= 0 ? 1 : -1)) {
        crossings++;
      }
      previous = value;
    }

    rms[f] = Math.sqrt(sumSquares / frameLength);
    zcr[f] = crossings / (frameLength - 1);
  }

  const sortedRms = Float64Array.from(rms).sort();
  const noiseFloor = percentile(sortedRms, NOISE_FLOOR_PERCENTILE);
  const peakRms = sortedRms[sortedRms.length - 1];
  const threshold = Math.max(
    noiseFloor * SPEECH_RMS_MULTIPLIER,
    MIN_SPEECH_RMS
  );

  // Pass 2: pitch. The adaptive threshold needs every frame's RMS before it can
  // be computed, which is why this cannot fold into pass 1. Only frames that
  // cleared the cheap gates are re-read, so noise-only stretches cost nothing.
  const frames = new Uint8Array(frameCount);
  const frameBuf = new Float64Array(frameLength);
  const pitchBuf = new Float64Array(Math.floor(frameLength / 2));

  for (let f = 0; f < frameCount; f++) {
    if (rms[f] < threshold || zcr[f] > MAX_SPEECH_ZCR) continue;

    for (let i = 0; i < frameLength; i++) {
      frameBuf[i] = samples[(f * frameLength + i) * stride * numChannels] / 32768;
    }
    if (
      pitchStrength(frameBuf, frameLength, analysisRate, pitchBuf) <
      MIN_PITCH_STRENGTH
    ) {
      continue;
    }
    frames[f] = 1;
  }

  const msPerFrame = (frameLength * stride * 1000) / sampleRate;

  // Drop runs too short to be speech. Done before anything reads `frames`, so
  // ratios, buckets and island boundaries all agree.
  const minRunFrames = Math.max(1, Math.round(MIN_SPEECH_RUN_MS / msPerFrame));
  let runStart = -1;
  for (let f = 0; f <= frameCount; f++) {
    if (f < frameCount && frames[f]) {
      if (runStart < 0) runStart = f;
      continue;
    }
    if (runStart >= 0) {
      if (f - runStart < minRunFrames) {
        frames.fill(0, runStart, f);
      }
      runStart = -1;
    }
  }

  let speechFrames = 0;
  for (let f = 0; f < frameCount; f++) speechFrames += frames[f];

  const buckets: number[] = [];
  const effectiveBuckets = Math.max(1, Math.min(bucketCount, frameCount));
  for (let b = 0; b < effectiveBuckets; b++) {
    const start = Math.floor((b * frameCount) / effectiveBuckets);
    const end = Math.max(
      start + 1,
      Math.floor(((b + 1) * frameCount) / effectiveBuckets)
    );
    let count = 0;
    for (let f = start; f < end && f < frameCount; f++) count += frames[f];
    buckets.push(count / (end - start));
  }

  return {
    buckets,
    speechRatio: speechFrames / frameCount,
    noiseFloor,
    peakRms,
    frameMs: msPerFrame,
    frames,
  };
}

export function speechRatioInRange(
  result: SpeechActivityResult,
  startMs: number,
  endMs: number
): number {
  const frameCount = result.frames.length;
  if (frameCount === 0 || result.frameMs <= 0) return 0;

  const startFrame = Math.max(0, Math.floor(startMs / result.frameMs));
  const endFrame = Math.min(frameCount, Math.ceil(endMs / result.frameMs));
  if (endFrame <= startFrame) return 0;

  let count = 0;
  for (let f = startFrame; f < endFrame; f++) count += result.frames[f];
  return count / (endFrame - startFrame);
}

export type SpeechIsland = { startMs: number; endMs: number };

/**
 * Groups speech into islands separated by long silences.
 *
 * Trimming a trailing silence is just the single-island case, so both the
 * "recording left running at the end" and the "one stray remark after 20
 * quiet minutes" shapes fall out of the same pass. Returns an empty array when
 * no speech was found at all — callers should then fall back to the whole file
 * rather than skipping everything.
 */
export function findSpeechIslands(
  result: SpeechActivityResult,
  totalMs: number,
  options?: {
    minGapMs?: number;
    paddingMs?: number;
    minIslandSpeechMs?: number;
  }
): SpeechIsland[] {
  const minGapMs = options?.minGapMs ?? MIN_SILENCE_GAP_MS;
  const paddingMs = options?.paddingMs ?? ISLAND_PADDING_MS;
  const minIslandSpeechMs =
    options?.minIslandSpeechMs ?? MIN_ISLAND_SPEECH_MS;

  const { frames, frameMs } = result;
  if (frames.length === 0 || frameMs <= 0) return [];

  const minGapFrames = Math.max(1, Math.round(minGapMs / frameMs));
  const minSpeechFrames = Math.max(1, Math.round(minIslandSpeechMs / frameMs));

  // Walk the frames, closing an island whenever the silence run gets long enough
  const raw: { start: number; end: number; speech: number }[] = [];
  let current: { start: number; end: number; speech: number } | null = null;
  let silenceRun = 0;

  for (let f = 0; f < frames.length; f++) {
    if (frames[f]) {
      if (!current) current = { start: f, end: f + 1, speech: 0 };
      current.end = f + 1;
      current.speech++;
      silenceRun = 0;
      continue;
    }
    if (!current) continue;
    silenceRun++;
    if (silenceRun >= minGapFrames) {
      raw.push(current);
      current = null;
      silenceRun = 0;
    }
  }
  if (current) raw.push(current);

  const islands: SpeechIsland[] = [];
  for (const island of raw) {
    if (island.speech < minSpeechFrames) continue;
    const startMs = Math.max(0, island.start * frameMs - paddingMs);
    const endMs = Math.min(totalMs, island.end * frameMs + paddingMs);
    if (endMs <= startMs) continue;

    // Padding can make neighbours touch; merge rather than emit overlaps
    const previous = islands[islands.length - 1];
    if (previous && startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, endMs);
      continue;
    }
    islands.push({ startMs, endMs });
  }

  return islands;
}
