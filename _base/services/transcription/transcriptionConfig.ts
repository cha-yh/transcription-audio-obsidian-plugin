import { MAX_CUSTOM_VOCABULARY_TERMS } from "_base/constants/setting";
import { AudioPluginSettings } from "_base/types/setting";

/** The settings a dedicated transcription request is built from. */
export type TranscriptionOptions = Pick<
  AudioPluginSettings,
  | "transcriptionMode"
  | "speakerDiarization"
  | "wordTimestamps"
  | "customVocabulary"
  | "languageCodes"
>;

/**
 * The options that actually take effect, after the API's own rules:
 * smart mode cannot label speakers or time words, and a custom vocabulary
 * cannot be combined with either. The settings UI greys out what this drops,
 * so a stored value the user cannot see never reaches a request.
 */
export function effectiveTranscriptionOptions(options: TranscriptionOptions): {
  smart: boolean;
  speakerDiarization: boolean;
  wordTimestamps: boolean;
  customVocabulary: string[];
  languageCodes: string[];
} {
  const smart = options.transcriptionMode === "smart";
  const speakerDiarization = !smart && options.speakerDiarization;
  const wordTimestamps = !smart && options.wordTimestamps;
  const vocabularyAllowed = !speakerDiarization && !wordTimestamps;

  return {
    smart,
    speakerDiarization,
    wordTimestamps,
    customVocabulary: vocabularyAllowed
      ? parseList(options.customVocabulary, /\n/).slice(
          0,
          MAX_CUSTOM_VOCABULARY_TERMS
        )
      : [],
    languageCodes: parseList(options.languageCodes, /[,\s]+/),
  };
}

function parseList(value: string, separator: RegExp): string[] {
  const seen = new Set<string>();
  for (const item of value.split(separator)) {
    const trimmed = item.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * The `generation_config` for an Interactions request, or undefined when every
 * option is at the API's default and the field can be left out.
 */
export function buildTranscriptionGenerationConfig(
  options: TranscriptionOptions
): Record<string, unknown> | undefined {
  const effective = effectiveTranscriptionOptions(options);
  const config: Record<string, unknown> = {};

  if (effective.languageCodes.length > 0) {
    config.language_codes = effective.languageCodes;
  }
  if (effective.customVocabulary.length > 0) {
    config.custom_vocabulary = effective.customVocabulary;
  }
  if (effective.smart) {
    config.mode = "smart";
  } else if (effective.speakerDiarization || effective.wordTimestamps) {
    config.mode = {
      type: "verbatim",
      ...(effective.speakerDiarization ? { diarization_mode: "speaker" } : {}),
      ...(effective.wordTimestamps
        ? { timestamp_granularities: ["word"] }
        : {}),
    };
  }

  return Object.keys(config).length > 0
    ? { transcription_config: config }
    : undefined;
}

export interface TranscribedWord {
  text: string;
  speaker?: string;
  startMs?: number;
  endMs?: number;
}

/** A pause this long starts a new paragraph when only timestamps are on. */
const PARAGRAPH_PAUSE_MS = 2000;

/** "1.250s" as returned for word offsets, in milliseconds. */
function parseOffset(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(parseFloat(match[1]) * 1000) : undefined;
}

/** Word annotations out of an Interactions response, in order. */
export function extractTranscribedWords(payload: unknown): TranscribedWord[] {
  const steps = (payload as { steps?: unknown[] } | null)?.steps ?? [];
  const words: TranscribedWord[] = [];

  for (const step of steps as { type?: string; content?: unknown[] }[]) {
    if (step.type !== "model_output") continue;
    for (const part of (step.content ?? []) as {
      annotations?: unknown[];
    }[]) {
      for (const annotation of (part.annotations ?? []) as Record<
        string,
        unknown
      >[]) {
        if (
          annotation.type !== "word_info" ||
          typeof annotation.text !== "string"
        ) {
          continue;
        }
        words.push({
          text: annotation.text,
          speaker:
            typeof annotation.speaker === "string"
              ? annotation.speaker
              : undefined,
          startMs: parseOffset(annotation.start_offset),
          endMs: parseOffset(annotation.end_offset),
        });
      }
    }
  }

  return words;
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** "spk_2" as "Speaker 2"; anything else is shown as given. */
function speakerLabel(speaker: string): string {
  const match = speaker.match(/^spk_(\d+)$/);
  return match ? `Speaker ${match[1]}` : speaker;
}

function joinWords(words: TranscribedWord[]): string {
  return words
    .map((w) => w.text)
    .reduce(
      (text, word) =>
        text.length === 0 || /^[.,!?;:…%)\]}]/.test(word)
          ? text + word
          : `${text} ${word}`,
      ""
    );
}

/**
 * Turns word annotations into paragraphs: a new one at every change of
 * speaker, or at a long pause when only timestamps are on. `offsetMs` shifts
 * the times of a chunk cut out of a longer recording back onto its timeline.
 */
export function formatTranscribedWords(
  words: TranscribedWord[],
  options: { speakers: boolean; timestamps: boolean; offsetMs?: number }
): string {
  const offsetMs = options.offsetMs ?? 0;
  const paragraphs: TranscribedWord[][] = [];

  for (const word of words) {
    const current = paragraphs[paragraphs.length - 1];
    const previous = current?.[current.length - 1];
    const speakerChanged =
      options.speakers && previous !== undefined && word.speaker !== previous.speaker;
    const longPause =
      !options.speakers &&
      options.timestamps &&
      previous?.endMs !== undefined &&
      word.startMs !== undefined &&
      word.startMs - previous.endMs >= PARAGRAPH_PAUSE_MS;

    if (!current || speakerChanged || longPause) {
      paragraphs.push([word]);
    } else {
      current.push(word);
    }
  }

  return paragraphs
    .map((paragraph) => {
      const first = paragraph[0];
      const prefixes: string[] = [];
      if (options.timestamps && first.startMs !== undefined) {
        prefixes.push(`[${formatTimestamp(first.startMs + offsetMs)}]`);
      }
      if (options.speakers && first.speaker) {
        prefixes.push(`**${speakerLabel(first.speaker)}:**`);
      }
      const text = joinWords(paragraph);
      return prefixes.length > 0 ? `${prefixes.join(" ")} ${text}` : text;
    })
    .join("\n\n");
}
