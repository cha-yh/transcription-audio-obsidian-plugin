import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "_base/constants/setting";
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
});
