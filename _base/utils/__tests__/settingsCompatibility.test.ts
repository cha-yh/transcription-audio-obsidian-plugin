import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
} from "_base/constants/setting";
import { getCompatibleSettings } from "../settingsCompatibility";

describe("getCompatibleSettings", () => {
  it("uses current defaults without marking absent settings for saving", () => {
    const { settings, shouldSave } = getCompatibleSettings(null);

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.categories).not.toBe(DEFAULT_SETTINGS.categories);
    expect(shouldSave).toBe(false);
  });

  it("converts retired transcription modes into summarizeTranscript", () => {
    expect(
      getCompatibleSettings({ mode: "transcription" }).settings
        .summarizeTranscript
    ).toBe(true);
    expect(
      getCompatibleSettings({ mode: "transcription-only" }).settings
        .summarizeTranscript
    ).toBe(false);

    const { settings, shouldSave } = getCompatibleSettings({ mode: "basic" });
    expect(settings).not.toHaveProperty("mode");
    expect(shouldSave).toBe(true);
  });

  it("converts deprecated transcription flags with transcriptionOnly taking precedence", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      enableTranscribeThenSummarize: true,
      transcriptionOnly: true,
    });

    expect(settings.summarizeTranscript).toBe(false);
    expect(settings).not.toHaveProperty("enableTranscribeThenSummarize");
    expect(settings).not.toHaveProperty("transcriptionOnly");
    expect(shouldSave).toBe(true);
  });

  it("removes retired API keys and General categories", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      apiKey: "deprecated-key",
      categories: [
        { id: "general", name: "General", prompt: "old", enabled: true },
        { id: "custom", name: "Custom", prompt: "custom", enabled: true },
      ],
    });

    expect(settings).not.toHaveProperty("apiKey");
    expect(settings.categories).toEqual([
      { id: "custom", name: "Custom", prompt: "custom", enabled: true },
    ]);
    expect(settings.prompt).toBe("old");
    expect(shouldSave).toBe(true);
  });

  it("adds enabled to legacy categories and migrates unsupported models", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      model: "gemini-3-pro-preview",
      categories: [
        { id: "enabled", name: "Enabled", prompt: "prompt" },
        { id: "disabled", name: "Disabled", prompt: "  " },
      ],
    });

    expect(settings.model).toBe("gemini-3.1-pro-preview");
    expect(settings.categories.map((category) => category.enabled)).toEqual([
      true,
      false,
    ]);
    expect(shouldSave).toBe(true);
  });

  it("falls back to the default model when a persisted model is unknown", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      model: "unknown-model",
    });

    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(shouldSave).toBe(true);
  });

  it("keeps a deliberately emptied category list empty", () => {
    const { settings, shouldSave } = getCompatibleSettings({ categories: [] });

    expect(settings.categories).toEqual([]);
    expect(shouldSave).toBe(false);
  });

  it("falls back to the defaults only when no list was ever persisted", () => {
    const { settings, shouldSave } = getCompatibleSettings({});

    expect(settings.categories).toEqual(DEFAULT_CATEGORIES);
    expect(settings.categories).not.toBe(DEFAULT_CATEGORIES);
    expect(shouldSave).toBe(false);
  });

  it("marks a corrupt non-array category list for rewriting", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      categories: "not-an-array",
    });

    expect(settings.categories).toEqual(DEFAULT_CATEGORIES);
    expect(shouldSave).toBe(true);
  });

  it("drops entries that hold nothing, without throwing", () => {
    const read = () => getCompatibleSettings({ categories: [null, "broken"] });

    expect(read).not.toThrow();

    const { settings, shouldSave } = read();
    expect(settings.categories).toEqual([]);
    expect(shouldSave).toBe(true);
  });

  it("fills in missing fields rather than deleting a tuned prompt", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      categories: [
        { prompt: "a prompt the user tuned" },
        { id: "no-name", enabled: true },
      ],
    });

    expect(settings.categories).toEqual([
      {
        id: "category-1",
        name: "category-1",
        prompt: "a prompt the user tuned",
        enabled: true,
      },
      { id: "no-name", name: "no-name", prompt: "", enabled: true },
    ]);
    expect(shouldSave).toBe(true);
  });

  it("migrates a customized General prompt into the default prompt", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      categories: [
        { id: "general", name: "General", prompt: "my tuned prompt", enabled: true },
      ],
    });

    expect(settings.prompt).toBe("my tuned prompt");
    expect(settings.categories).toEqual([]);
    expect(shouldSave).toBe(true);
  });

  it("never overwrites an already customized prompt with the General one", () => {
    const { settings } = getCompatibleSettings({
      prompt: "prompt the user wrote",
      categories: [
        { id: "general", name: "General", prompt: "my tuned prompt", enabled: true },
      ],
    });

    expect(settings.prompt).toBe("prompt the user wrote");
  });

  it("leaves the prompt alone when General was never customized", () => {
    const { settings } = getCompatibleSettings({
      categories: [
        {
          id: "general",
          name: "General",
          prompt: DEFAULT_BASIC_MODE_PROMPT,
          enabled: true,
        },
      ],
    });

    expect(settings.prompt).toBe(DEFAULT_BASIC_MODE_PROMPT);
  });

  it("retires the template mode and its toggle", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      mode: "template",
      enableTemplatePrompt: true,
    });

    expect(settings).not.toHaveProperty("mode");
    expect(settings).not.toHaveProperty("enableTemplatePrompt");
    expect(shouldSave).toBe(true);
  });

  it("keeps retired template text the user wrote", () => {
    // Nothing reads these any more, but erasing them is irreversible and the
    // text is the user's.
    const { settings, shouldSave } = getCompatibleSettings({
      templatePrompt: "template prompt",
      outputTemplate: "## Heading",
    });

    expect(settings).toMatchObject({
      templatePrompt: "template prompt",
      outputTemplate: "## Heading",
    });
    expect(shouldSave).toBe(false);
  });

  it("keeps a General prompt migratable even when the prompt is corrupt", () => {
    const { settings } = getCompatibleSettings({
      prompt: null,
      categories: [
        { id: "general", name: "General", prompt: "my tuned prompt" },
      ],
    });

    expect(settings.prompt).toBe("my tuned prompt");
  });

  it("gives a generated id that does not collide with a persisted one", () => {
    const { settings } = getCompatibleSettings({
      categories: [
        { id: "category-1", name: "A", prompt: "p", enabled: true },
        { name: "B", prompt: "q", enabled: true },
      ],
    });

    const ids = settings.categories.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("category-1");
  });

  it("replaces primitives persisted with the wrong type", () => {
    const { settings, shouldSave } = getCompatibleSettings({
      summarizeTranscript: null,
      // Truthy as a string, so it would otherwise switch classification on for
      // a user who has it off.
      enableCategoryClassification: "false",
      prompt: null,
      secretApiKeyName: 42,
    });

    expect(settings.summarizeTranscript).toBe(
      DEFAULT_SETTINGS.summarizeTranscript
    );
    expect(settings.enableCategoryClassification).toBe(false);
    expect(settings.prompt).toBe(DEFAULT_SETTINGS.prompt);
    expect(settings.secretApiKeyName).toBe(DEFAULT_SETTINGS.secretApiKeyName);
    expect(shouldSave).toBe(true);
  });
});
