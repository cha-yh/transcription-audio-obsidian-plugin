export type TranscriptionInputMode =
  | "basic"
  | "transcription"
  | "transcription-only";

export interface TranscriptionCategory {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

export interface AudioPluginSettings {
  mode: TranscriptionInputMode;
  model: string;
  secretApiKeyName: string;
  prompt: string;
  enableTemplatePrompt: boolean;
  templatePrompt: string;
  outputTemplate: string;
  enableCategoryClassification: boolean;
  categories: TranscriptionCategory[];
  /** Keep progress-panel runs across plugin reloads. */
  enableSessionHistory: boolean;
  /** Drop the oldest kept runs once there are more than the limit. */
  autoPruneSessionHistory: boolean;
  sessionHistoryLimit: number;
}
