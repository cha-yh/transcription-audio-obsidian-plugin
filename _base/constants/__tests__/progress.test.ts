import { describe, it, expect } from "vitest";
import { getProgressViewType, VIEW_TITLE, VIEW_ICON } from "../progress";

describe("getProgressViewType", () => {
  it("returns '{pluginId}-progress-view'", () => {
    expect(getProgressViewType("my-plugin")).toBe("my-plugin-progress-view");
  });

  it("works with different plugin IDs", () => {
    expect(getProgressViewType("transcription-audio")).toBe(
      "transcription-audio-progress-view"
    );
  });
});

describe("constants", () => {
  it("VIEW_TITLE is defined", () => {
    expect(VIEW_TITLE).toBe("Transcription progress");
  });

  it("VIEW_ICON is defined", () => {
    expect(VIEW_ICON).toBe("audio-file");
  });
});
