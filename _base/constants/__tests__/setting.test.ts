import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_CATEGORIES,
  GENERAL_CATEGORY_ID,
  MODELS,
  MODEL_MIGRATIONS,
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_TEMPLATE_MODE_PROMPT,
  DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
  DEFAULT_CATEGORY_PROMPT_1ON1,
  DEFAULT_CATEGORY_PROMPT_TECH_MEETING,
  DEFAULT_CATEGORY_PROMPT_PROJECT,
  DEFAULT_CATEGORY_PROMPT_GENERAL,
} from "../setting";

describe("DEFAULT_SETTINGS", () => {
  it("has all required fields", () => {
    expect(DEFAULT_SETTINGS).toHaveProperty("mode");
    expect(DEFAULT_SETTINGS).toHaveProperty("model");
    expect(DEFAULT_SETTINGS).toHaveProperty("secretApiKeyName");
    expect(DEFAULT_SETTINGS).toHaveProperty("enableTemplatePrompt");
    expect(DEFAULT_SETTINGS).toHaveProperty("templatePrompt");
    expect(DEFAULT_SETTINGS).toHaveProperty("outputTemplate");
    expect(DEFAULT_SETTINGS).toHaveProperty("prompt");
    expect(DEFAULT_SETTINGS).toHaveProperty("enableCategoryClassification");
    expect(DEFAULT_SETTINGS).toHaveProperty("categories");
  });

  it("does not expose deprecated transcription toggle fields", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty(
      "enableTranscribeThenSummarize"
    );
    expect(DEFAULT_SETTINGS).not.toHaveProperty("transcriptionOnly");
  });

  it("has valid default values", () => {
    expect(DEFAULT_SETTINGS.mode).toBe("basic");
    expect(DEFAULT_SETTINGS.enableTemplatePrompt).toBe(false);
    expect(DEFAULT_SETTINGS.enableCategoryClassification).toBe(false);
  });

  it("model is a valid model from MODELS", () => {
    expect(MODELS).toContain(DEFAULT_SETTINGS.model);
  });
});

describe("DEFAULT_CATEGORIES", () => {
  it("has 4 categories", () => {
    expect(DEFAULT_CATEGORIES).toHaveLength(4);
  });

  it("includes General category", () => {
    const general = DEFAULT_CATEGORIES.find(
      (c) => c.id === GENERAL_CATEGORY_ID
    );
    expect(general).toBeDefined();
    expect(general!.name).toBe("General");
  });

  it("all categories are enabled", () => {
    for (const cat of DEFAULT_CATEGORIES) {
      expect(cat.enabled).toBe(true);
    }
  });

  it("all categories have non-empty prompts", () => {
    for (const cat of DEFAULT_CATEGORIES) {
      expect(cat.prompt.length).toBeGreaterThan(0);
    }
  });

  it("all categories have id and name", () => {
    for (const cat of DEFAULT_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
    }
  });
});

describe("GENERAL_CATEGORY_ID", () => {
  it("is 'general'", () => {
    expect(GENERAL_CATEGORY_ID).toBe("general");
  });
});

describe("MODELS", () => {
  it("is a non-empty array", () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  it("contains only strings", () => {
    for (const m of MODELS) {
      expect(typeof m).toBe("string");
    }
  });

  it("includes gemini-3.5-flash", () => {
    expect(MODELS).toContain("gemini-3.5-flash");
  });
});

describe("MODEL_MIGRATIONS", () => {
  it("has valid key-value pairs", () => {
    for (const [key, value] of Object.entries(MODEL_MIGRATIONS)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("migration targets exist in MODELS", () => {
    for (const target of Object.values(MODEL_MIGRATIONS)) {
      expect(MODELS).toContain(target);
    }
  });
});

describe("Prompt constants", () => {
  it("all prompts are non-empty strings", () => {
    expect(DEFAULT_BASIC_MODE_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_TEMPLATE_MODE_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_TRANSCRIPTION_ONLY_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_CATEGORY_PROMPT_1ON1.length).toBeGreaterThan(0);
    expect(DEFAULT_CATEGORY_PROMPT_TECH_MEETING.length).toBeGreaterThan(0);
    expect(DEFAULT_CATEGORY_PROMPT_PROJECT.length).toBeGreaterThan(0);
    expect(DEFAULT_CATEGORY_PROMPT_GENERAL.length).toBeGreaterThan(0);
  });
});
