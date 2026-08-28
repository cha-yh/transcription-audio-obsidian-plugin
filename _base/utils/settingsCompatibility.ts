import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  MODELS,
  MODEL_MIGRATIONS,
} from "_base/constants/setting";
import { AudioPluginSettings, TranscriptionCategory } from "_base/types/setting";

type SavedSettings = Partial<AudioPluginSettings> & {
  apiKey?: string;
  mode?: "basic" | "transcription" | "transcription-only" | "template";
  enableTranscribeThenSummarize?: boolean;
  transcriptionOnly?: boolean;
};

export interface CompatibleSettings {
  settings: AudioPluginSettings;
  shouldSave: boolean;
}

function cloneCategories(
  categories: TranscriptionCategory[]
): TranscriptionCategory[] {
  return categories.map((category) => ({ ...category }));
}

/** Converts settings persisted by earlier releases to the current shape. */
export function getCompatibleSettings(saved: unknown): CompatibleSettings {
  const savedSettings =
    saved && typeof saved === "object" ? (saved as SavedSettings) : {};
  const {
    apiKey: deprecatedApiKey,
    mode: savedMode,
    enableTranscribeThenSummarize: deprecatedTranscribeThenSummarize,
    transcriptionOnly: deprecatedTranscriptionOnly,
    ...currentSettings
  } = savedSettings;

  const settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);
  const savedCategories = Array.isArray(savedSettings.categories)
    ? savedSettings.categories
    : [];
  const categoriesToLoad =
    savedCategories.length > 0 ? savedCategories : DEFAULT_CATEGORIES;
  settings.categories = cloneCategories(
    categoriesToLoad.filter((category) => category.id !== "general")
  );

  let shouldSave =
    deprecatedApiKey !== undefined ||
    deprecatedTranscribeThenSummarize !== undefined ||
    deprecatedTranscriptionOnly !== undefined ||
    savedMode !== undefined ||
    settings.categories.length !== categoriesToLoad.length;

  settings.summarizeTranscript =
    deprecatedTranscriptionOnly
      ? false
      : deprecatedTranscribeThenSummarize || savedMode === "transcription"
      ? true
      : savedMode === "transcription-only"
      ? false
      : settings.summarizeTranscript;

  const previousModel = settings.model;
  const migratedModel = MODEL_MIGRATIONS[previousModel] || previousModel;
  settings.model = MODELS.includes(migratedModel)
    ? migratedModel
    : DEFAULT_SETTINGS.model;
  if (settings.model !== previousModel) shouldSave = true;

  for (const category of settings.categories) {
    if (category.enabled === undefined) {
      category.enabled = (category.prompt || "").trim().length > 0;
      shouldSave = true;
    }
  }

  return { settings, shouldSave };
}
