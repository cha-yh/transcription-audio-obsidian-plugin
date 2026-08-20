import { describe, it, expect, vi } from "vitest";
import { AudioService } from "../AudioService";
import {
  createTestWavBuffer,
  createNonPcm16WavBuffer,
} from "../../../../tests/helpers/createTestWavBuffer";

const audio = new AudioService();

describe("sliceWavPcm16ToBlob", () => {
  it("produces the same bytes as the copying slice", async () => {
    const buf = createTestWavBuffer(1000, 16000, 1);
    const header = audio.parseWavHeader(buf);

    const copied = audio.sliceWavPcm16(buf, 200, 700);
    const referenced = audio.sliceWavPcm16ToBlob(
      new Blob([buf]),
      header,
      200,
      700
    );

    expect(referenced.size).toBe(copied.byteLength);
    expect(new Uint8Array(await referenced.arrayBuffer())).toEqual(
      new Uint8Array(copied)
    );
  });

  it("writes a header the parser accepts", async () => {
    const buf = createTestWavBuffer(2000, 16000, 1);
    const header = audio.parseWavHeader(buf);

    const blob = audio.sliceWavPcm16ToBlob(new Blob([buf]), header, 0, 500);
    const sliced = audio.parseWavHeader(await blob.arrayBuffer());

    expect(sliced.audioFormat).toBe(1);
    expect(sliced.sampleRate).toBe(16000);
    expect(sliced.numChannels).toBe(1);
    expect(sliced.bitsPerSample).toBe(16);
    expect(sliced.dataSize).toBe(500 * 16000 * 2 / 1000);
  });

  it("clamps a range that runs past the end", async () => {
    const buf = createTestWavBuffer(500, 16000, 1);
    const header = audio.parseWavHeader(buf);

    const blob = audio.sliceWavPcm16ToBlob(new Blob([buf]), header, 0, 99999);
    expect(blob.size).toBe(buf.byteLength);
  });

  it("rejects non-PCM16 input", () => {
    const buf = createNonPcm16WavBuffer(500);
    const header = audio.parseWavHeader(buf);

    expect(() =>
      audio.sliceWavPcm16ToBlob(new Blob([buf]), header, 0, 100)
    ).toThrow("Only PCM 16-bit WAV is supported");
  });
});

describe("parseWavHeader", () => {
  it("parses a valid WAV header", () => {
    const buf = createTestWavBuffer(1000, 44100, 2);
    const header = audio.parseWavHeader(buf);
    expect(header.audioFormat).toBe(1);
    expect(header.sampleRate).toBe(44100);
    expect(header.numChannels).toBe(2);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataOffset).toBe(44);
    expect(header.dataSize).toBeGreaterThan(0);
  });

  it("throws on non-RIFF buffer", () => {
    const buf = new ArrayBuffer(44);
    expect(() => audio.parseWavHeader(buf)).toThrow("RIFF/WAVE");
  });

  it("throws on RIFF but non-WAVE buffer", () => {
    const buf = new ArrayBuffer(44);
    const view = new DataView(buf);
    [82, 73, 70, 70].forEach((c, i) => view.setUint8(i, c));
    [65, 86, 73, 32].forEach((c, i) => view.setUint8(8 + i, c));
    expect(() => audio.parseWavHeader(buf)).toThrow("RIFF/WAVE");
  });

  it("throws on missing fmt/data chunk", () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    [82, 73, 70, 70].forEach((c, i) => view.setUint8(i, c));
    view.setUint32(4, 4, true);
    [87, 65, 86, 69].forEach((c, i) => view.setUint8(8 + i, c));
    expect(() => audio.parseWavHeader(buf)).toThrow("fmt or data");
  });

  it("parses mono 16kHz correctly", () => {
    const buf = createTestWavBuffer(500, 16000, 1);
    const header = audio.parseWavHeader(buf);
    expect(header.sampleRate).toBe(16000);
    expect(header.numChannels).toBe(1);
  });
});

describe("sliceWavPcm16", () => {
  it("returns the full range when slicing entire buffer", () => {
    const durationMs = 2000;
    const buf = createTestWavBuffer(durationMs, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 0, durationMs);
    const origHeader = audio.parseWavHeader(buf);
    const slicedHeader = audio.parseWavHeader(sliced);
    expect(slicedHeader.dataSize).toBe(origHeader.dataSize);
  });

  it("returns a partial range with correct byte count", () => {
    const buf = createTestWavBuffer(2000, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 0, 1000);
    const header = audio.parseWavHeader(sliced);
    expect(header.dataSize).toBe(16000 * 2);
  });

  it("slices from startMs=0 correctly", () => {
    const buf = createTestWavBuffer(3000, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 0, 1500);
    const header = audio.parseWavHeader(sliced);
    expect(header.dataSize).toBeGreaterThan(0);
    expect(header.sampleRate).toBe(16000);
  });

  it("clamps endMs beyond total duration", () => {
    const buf = createTestWavBuffer(1000, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 0, 5000);
    const origHeader = audio.parseWavHeader(buf);
    const slicedHeader = audio.parseWavHeader(sliced);
    expect(slicedHeader.dataSize).toBe(origHeader.dataSize);
  });

  it("returns empty data when startMs equals totalMs", () => {
    const buf = createTestWavBuffer(1000, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 1000, 1500);
    const header = audio.parseWavHeader(sliced);
    expect(header.dataSize).toBe(0);
  });

  it("works without endMs (slices to end)", () => {
    const buf = createTestWavBuffer(2000, 16000, 1);
    const sliced = audio.sliceWavPcm16(buf, 500);
    const header = audio.parseWavHeader(sliced);
    expect(header.dataSize).toBeGreaterThan(0);
  });

  it("throws for non-PCM16 WAV", () => {
    const buf = createNonPcm16WavBuffer(1000);
    expect(() => audio.sliceWavPcm16(buf, 0, 500)).toThrow("PCM 16-bit WAV");
  });

  it("generates valid WAV header in sliced output", () => {
    const buf = createTestWavBuffer(2000, 44100, 2);
    const sliced = audio.sliceWavPcm16(buf, 500, 1500);
    const header = audio.parseWavHeader(sliced);
    expect(header.audioFormat).toBe(1);
    expect(header.sampleRate).toBe(44100);
    expect(header.numChannels).toBe(2);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataOffset).toBe(44);
  });
});
