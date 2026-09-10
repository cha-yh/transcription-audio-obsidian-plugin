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
  /** Keep progress-panel runs across plugin reloads. */
  enableSessionHistory: boolean;
  /** Drop the oldest kept runs once there are more than the limit. */
  autoPruneSessionHistory: boolean;
  sessionHistoryLimit: number;
}
