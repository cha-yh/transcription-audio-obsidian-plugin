export type TranscriptionInputMode = "basic" | "template";

export interface AudioPluginSettings {
  mode: TranscriptionInputMode;
  model: string;
  apiKey: string;
  secretApiKeyName: string;
  prompt: string;
  templatePrompt: string;
  outputTemplate: string;
}
