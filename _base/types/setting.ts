export interface TranscriptionCategory {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

/**
 * `verbatim` keeps every filler and false start; `smart` cleans them up but
 * cannot label speakers or time words.
 */
export type TranscriptionMode = "verbatim" | "smart";

export interface AudioPluginSettings {
  /** Whether to generate a summary after the always-on transcription step. */
  summarizeTranscript: boolean;
  model: string;
  /** Dedicated speech-to-text model for the transcription step. */
  transcriptionModel: string;
  transcriptionMode: TranscriptionMode;
  /** Label who is speaking. Verbatim only; caps a request at 30 minutes. */
  speakerDiarization: boolean;
  /** Time each word. Verbatim only; caps a request at 30 minutes. */
  wordTimestamps: boolean;
  /** Terms to recognize, one per line. Ignored with diarization or timestamps. */
  customVocabulary: string;
  /** BCP-47 language hints, comma separated. Empty detects the language. */
  languageCodes: string;
  secretApiKeyName: string;
  prompt: string;
  enableCategoryClassification: boolean;
  categories: TranscriptionCategory[];
  /** Keep progress-panel runs across plugin reloads. */
  enableSessionHistory: boolean;
  /** Drop the oldest kept runs once there are more than the limit. */
  autoPruneSessionHistory: boolean;
  sessionHistoryLimit: number;
}
