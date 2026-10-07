import { describe, it, expect } from "vitest";
import {
  TranscriptionOptions,
  buildTranscriptionGenerationConfig,
  effectiveTranscriptionOptions,
  extractTranscribedWords,
  formatTimestamp,
  formatTranscribedWords,
} from "../transcriptionConfig";

const defaults: TranscriptionOptions = {
  transcriptionMode: "verbatim",
  speakerDiarization: false,
  wordTimestamps: false,
  customVocabulary: "",
  languageCodes: "",
};

describe("buildTranscriptionGenerationConfig", () => {
  it("leaves the config out when every option is at the API default", () => {
    expect(buildTranscriptionGenerationConfig(defaults)).toBeUndefined();
  });

  it("sends speakers and timestamps under a verbatim mode object", () => {
    expect(
      buildTranscriptionGenerationConfig({
        ...defaults,
        speakerDiarization: true,
        wordTimestamps: true,
      })
    ).toEqual({
      transcription_config: {
        mode: {
          type: "verbatim",
          diarization_mode: "speaker",
          timestamp_granularities: ["word"],
        },
      },
    });
  });

  it("sends smart mode with vocabulary and language hints", () => {
    expect(
      buildTranscriptionGenerationConfig({
        ...defaults,
        transcriptionMode: "smart",
        customVocabulary: "Obsidian\n\n  Gemini \nObsidian",
        languageCodes: "ko-KR, en-US",
      })
    ).toEqual({
      transcription_config: {
        language_codes: ["ko-KR", "en-US"],
        custom_vocabulary: ["Obsidian", "Gemini"],
        mode: "smart",
      },
    });
  });
});

describe("effectiveTranscriptionOptions", () => {
  it("drops speakers and timestamps in smart mode", () => {
    const effective = effectiveTranscriptionOptions({
      ...defaults,
      transcriptionMode: "smart",
      speakerDiarization: true,
      wordTimestamps: true,
      customVocabulary: "Obsidian",
    });

    expect(effective.speakerDiarization).toBe(false);
    expect(effective.wordTimestamps).toBe(false);
    // With both dropped, the vocabulary is allowed again.
    expect(effective.customVocabulary).toEqual(["Obsidian"]);
  });

  it("drops the vocabulary while speakers or timestamps are on", () => {
    for (const option of ["speakerDiarization", "wordTimestamps"] as const) {
      expect(
        effectiveTranscriptionOptions({
          ...defaults,
          [option]: true,
          customVocabulary: "Obsidian",
        }).customVocabulary
      ).toEqual([]);
    }
  });

  it("caps the vocabulary at the API's limit", () => {
    const terms = Array.from({ length: 1005 }, (_, i) => `term${i}`);
    expect(
      effectiveTranscriptionOptions({
        ...defaults,
        customVocabulary: terms.join("\n"),
      }).customVocabulary
    ).toHaveLength(1000);
  });
});

describe("extractTranscribedWords", () => {
  it("reads word annotations of model output, converting offsets to ms", () => {
    expect(
      extractTranscribedWords({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "Hello world",
                annotations: [
                  {
                    type: "word_info",
                    text: "Hello",
                    speaker: "spk_1",
                    start_offset: "0.100s",
                    end_offset: "0.450s",
                  },
                  { type: "other", text: "skip" },
                  { type: "word_info", text: "world" },
                ],
              },
            ],
          },
        ],
      })
    ).toEqual([
      { text: "Hello", speaker: "spk_1", startMs: 100, endMs: 450 },
      { text: "world", speaker: undefined, startMs: undefined, endMs: undefined },
    ]);
  });

  it("returns nothing for a response without annotations", () => {
    expect(extractTranscribedWords({ steps: [] })).toEqual([]);
    expect(extractTranscribedWords(null)).toEqual([]);
  });
});

describe("formatTimestamp", () => {
  it("shows hours only once the recording reaches them", () => {
    expect(formatTimestamp(65_400)).toBe("01:05");
    expect(formatTimestamp(3_725_000)).toBe("1:02:05");
  });
});

describe("formatTranscribedWords", () => {
  const words = [
    { text: "안녕하세요", speaker: "spk_1", startMs: 0, endMs: 800 },
    { text: "반갑습니다", speaker: "spk_1", startMs: 900, endMs: 1500 },
    { text: "네", speaker: "spk_2", startMs: 1600, endMs: 1800 },
    { text: ".", speaker: "spk_2", startMs: 1800, endMs: 1800 },
    { text: "시작할게요", speaker: "spk_2", startMs: 5000, endMs: 5600 },
  ];

  it("starts a labelled paragraph at each change of speaker", () => {
    expect(
      formatTranscribedWords(words, { speakers: true, timestamps: false })
    ).toBe(
      "**Speaker 1:** 안녕하세요 반갑습니다\n\n**Speaker 2:** 네. 시작할게요"
    );
  });

  it("shifts timestamps by the chunk's place in the recording", () => {
    expect(
      formatTranscribedWords(words, {
        speakers: true,
        timestamps: true,
        offsetMs: 20 * 60 * 1000,
      })
    ).toBe(
      "[20:00] **Speaker 1:** 안녕하세요 반갑습니다\n\n[20:01] **Speaker 2:** 네. 시작할게요"
    );
  });

  it("breaks on long pauses when only timestamps are on", () => {
    expect(
      formatTranscribedWords(words, { speakers: false, timestamps: true })
    ).toBe("[00:00] 안녕하세요 반갑습니다 네.\n\n[00:05] 시작할게요");
  });
});
