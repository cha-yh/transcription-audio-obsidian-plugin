export interface TranscriptionCategory {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

export interface AudioPluginSettings {
  /** Whether to generate a summary after the always-on transcription step. */
  summarizeTranscript: boolean;
  model: string;
  secretApiKeyName: string;
  prompt: string;
  enableCategoryClassification: boolean;
  categories: TranscriptionCategory[];
}
