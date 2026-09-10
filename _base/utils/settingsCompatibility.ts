import {
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  MODELS,
  MODEL_MIGRATIONS,
} from "_base/constants/setting";
import { AudioPluginSettings, TranscriptionCategory } from "_base/types/setting";

const RETIRED_GENERAL_CATEGORY_ID = "general";

type SavedSettings = Partial<AudioPluginSettings> & {
  apiKey?: string;
  mode?: "basic" | "transcription" | "transcription-only" | "template";
  enableTranscribeThenSummarize?: boolean;
  transcriptionOnly?: boolean;
  enableTemplatePrompt?: boolean;
  templatePrompt?: string;
  outputTemplate?: string;
};

export interface CompatibleSettings {
  settings: AudioPluginSettings;
  shouldSave: boolean;
}

/**
 * Normalizes one persisted category.
 */
function toCategory(
  value: unknown,
  taken: Set<string>
): TranscriptionCategory | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<TranscriptionCategory>;
  let id = typeof candidate.id === "string" ? candidate.id : "";
  if (id.length === 0 || taken.has(id)) {
    let suffix = taken.size + 1;
    while (taken.has(`category-${suffix}`)) suffix++;
    id = `category-${suffix}`;
  }
  taken.add(id);
  const name =
    typeof candidate.name === "string" && candidate.name.trim().length > 0
      ? candidate.name
      : id;
  const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";

  return {
    id,
    name,
    prompt,
    // Before the enabled flag existed, a category counted as enabled exactly
    // when it had a prompt to contribute.
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : prompt.trim().length > 0
  };
}

/** The primitive settings, and the type each has to arrive as. */
const PRIMITIVE_TYPES: Partial<
  Record<keyof AudioPluginSettings, "string" | "boolean">
> = {
  summarizeTranscript: "boolean",
  enableCategoryClassification: "boolean",
  prompt: "string",
  model: "string",
  secretApiKeyName: "string"
};

/**
 * Replaces any primitive that arrived as the wrong type with its default.
 *
 * data.json is a plain file a user can edit, and an untyped value otherwise
 * reaches a toggle or a request as-is: a persisted `"false"` string is truthy
 * and reads as on, and a null prompt reaches `setValue`.
 */
function coercePrimitives(settings: AudioPluginSettings): boolean {
  let changed = false;

  for (const [key, expected] of Object.entries(PRIMITIVE_TYPES)) {
    const field = key as keyof AudioPluginSettings;
    if (typeof settings[field] !== expected) {
      (settings as unknown as Record<string, unknown>)[field] =
        DEFAULT_SETTINGS[field];
      changed = true;
    }
  }

  return changed;
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
    enableTemplatePrompt: deprecatedEnableTemplatePrompt,
    ...currentSettings
  } = savedSettings;

  const settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);

  let shouldSave =
    deprecatedApiKey !== undefined ||
    deprecatedTranscribeThenSummarize !== undefined ||
    deprecatedTranscriptionOnly !== undefined ||
    deprecatedEnableTemplatePrompt !== undefined ||
    savedMode !== undefined;

  const savedCategories = savedSettings.categories;
  const categoriesToLoad = Array.isArray(savedCategories)
    ? savedCategories
    : DEFAULT_CATEGORIES;

  const takenIds = new Set<string>();
  const normalized = categoriesToLoad
    .map((value) => toCategory(value, takenIds))
    .filter((category): category is TranscriptionCategory => category !== null);
  const retiredGeneral = normalized.find(
    (category) => category.id === RETIRED_GENERAL_CATEGORY_ID
  );
  settings.categories = normalized.filter(
    (category) => category.id !== RETIRED_GENERAL_CATEGORY_ID
  );

  if (Array.isArray(savedCategories)) {
    // Anything the normalization touched — a dropped entry, a filled-in field,
    // a retired General — has to reach disk, or it is redone on every launch.
    if (
      JSON.stringify(settings.categories) !== JSON.stringify(savedCategories)
    ) {
      shouldSave = true;
    }
  } else if (savedCategories !== undefined) {
    // A persisted non-array is corrupt. Repairing it in memory only would leave
    // it in the file for every future launch to trip over.
    shouldSave = true;
  }

  if (coercePrimitives(settings)) shouldSave = true;

  // The retired General category held the prompt used whenever classification
  // matched nothing, and the mode settings made `prompt` unreachable while
  // classification was on — so General's prompt is the one the user actually
  // tuned. Carry it over instead of dropping it, but never over a `prompt` the
  // user has already customized.
  if (
    retiredGeneral &&
    retiredGeneral.prompt.trim().length > 0 &&
    retiredGeneral.prompt !== DEFAULT_BASIC_MODE_PROMPT &&
    settings.prompt === DEFAULT_BASIC_MODE_PROMPT
  ) {
    settings.prompt = retiredGeneral.prompt;
    shouldSave = true;
  }

  // Precedence, highest first: the transcriptionOnly flag, then the
  // transcribe-then-summarize flag, then the retired mode string. Stated as a
  // guard sequence so each rule can be checked against the one it overrides.
  if (deprecatedTranscriptionOnly) {
    settings.summarizeTranscript = false;
  } else if (deprecatedTranscribeThenSummarize) {
    settings.summarizeTranscript = true;
  } else if (savedMode === "transcription") {
    settings.summarizeTranscript = true;
  } else if (savedMode === "transcription-only") {
    settings.summarizeTranscript = false;
  }

  const previousModel = settings.model;
  const migratedModel = MODEL_MIGRATIONS[previousModel] || previousModel;
  settings.model = MODELS.includes(migratedModel)
    ? migratedModel
    : DEFAULT_SETTINGS.model;
  if (settings.model !== previousModel) shouldSave = true;

  return { settings, shouldSave };
}
