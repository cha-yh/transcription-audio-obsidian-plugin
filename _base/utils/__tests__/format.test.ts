import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatTimeRange,
  formatTimestamp,
} from "../format";

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

describe("formatTimestamp", () => {
  it("returns '0:00' for 0", () => {
    expect(formatTimestamp(0)).toBe("0:00");
  });

  it("pads seconds with leading zero", () => {
    expect(formatTimestamp(5000)).toBe("0:05");
  });

  it("uses m:ss below one hour", () => {
    expect(formatTimestamp(20 * 60 * 1000)).toBe("20:00");
  });

  it("switches to h:mm:ss at one hour", () => {
    expect(formatTimestamp(3600000)).toBe("1:00:00");
  });

  it("pads minutes and seconds in h:mm:ss", () => {
    expect(formatTimestamp(75 * 60 * 1000 + 4500)).toBe("1:15:04");
  });

  it("returns '0:00' for negative, NaN, and Infinity", () => {
    expect(formatTimestamp(-5000)).toBe("0:00");
    expect(formatTimestamp(NaN)).toBe("0:00");
    expect(formatTimestamp(Infinity)).toBe("0:00");
  });
});

describe("formatTimeRange", () => {
  it("renders start, end, and length", () => {
    expect(formatTimeRange(0, 20 * 60 * 1000)).toBe("0:00-20:00 (20:00)");
  });

  it("keeps the length relative to the start offset", () => {
    // Chunk 2 of a 20-minute split with 1.5s overlap
    expect(formatTimeRange(1198500, 2398500)).toBe("19:58-39:58 (20:00)");
  });

  it("renders hour-long offsets as h:mm:ss", () => {
    expect(formatTimeRange(3595500, 4500000)).toBe(
      "59:55-1:15:00 (15:04)"
    );
  });

  it("clamps a negative length to zero", () => {
    expect(formatTimeRange(5000, 1000)).toBe("0:05-0:01 (0:00)");
  });
});
