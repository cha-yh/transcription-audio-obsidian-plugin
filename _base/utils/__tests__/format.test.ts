import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration } from "../format";

describe("formatBytes", () => {
  it("returns '0 B' for 0", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns bytes for small values", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("returns KB for 1024", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("returns MB for 1048576", () => {
    expect(formatBytes(1048576)).toBe("1 MB");
  });

  it("returns GB for large values", () => {
    expect(formatBytes(1073741824)).toBe("1 GB");
  });

  it("returns '0 B' for negative values", () => {
    expect(formatBytes(-100)).toBe("0 B");
  });

  it("returns '0 B' for NaN", () => {
    expect(formatBytes(NaN)).toBe("0 B");
  });

  it("returns '0 B' for Infinity", () => {
    expect(formatBytes(Infinity)).toBe("0 B");
  });

  it("formats fractional KB correctly", () => {
    // 1536 = 1.5 KB
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("formatDuration", () => {
  it("returns '0:00' for 0", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("returns '1:01' for 61000ms", () => {
    expect(formatDuration(61000)).toBe("1:01");
  });

  it("returns '60:00' for 3600000ms (1 hour)", () => {
    expect(formatDuration(3600000)).toBe("60:00");
  });

  it("returns '0:00' for negative values", () => {
    expect(formatDuration(-5000)).toBe("0:00");
  });

  it("returns '0:00' for NaN", () => {
    expect(formatDuration(NaN)).toBe("0:00");
  });

  it("returns '0:00' for Infinity", () => {
    expect(formatDuration(Infinity)).toBe("0:00");
  });

  it("pads seconds with leading zero", () => {
    expect(formatDuration(5000)).toBe("0:05");
  });

  it("handles 30 minutes", () => {
    expect(formatDuration(30 * 60 * 1000)).toBe("30:00");
  });
});
