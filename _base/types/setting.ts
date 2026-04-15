export type TranscriptionInputMode = "basic" | "template";

export interface TranscriptionCategory {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

export interface AudioPluginSettings {
  mode: TranscriptionInputMode;
  model: string;
  apiKey: string;
  secretApiKeyName: string;
  prompt: string;
  templatePrompt: string;
  outputTemplate: string;
  enableTranscribeThenSummarize: boolean;
  transcriptionOnly: boolean;
  enableCategoryClassification: boolean;
  categories: TranscriptionCategory[];
}
