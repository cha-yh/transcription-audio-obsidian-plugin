import { describe, it, expect, vi, beforeEach } from "vitest";
import { progressBus } from "../progressBus";

beforeEach(() => {
  progressBus.clear();
});

describe("ProgressBus", () => {
  it("delivers events to subscribers", () => {
    const handler = vi.fn();
    progressBus.subscribe(handler);
    progressBus.publish({ stage: "success" });
    expect(handler).toHaveBeenCalledWith({ stage: "success" });
  });

  it("delivers events to multiple subscribers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    progressBus.subscribe(h1);
    progressBus.subscribe(h2);
    progressBus.publish({ stage: "file-upload-start" });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("stops delivering after unsubscribe", () => {
    const handler = vi.fn();
    const unsub = progressBus.subscribe(handler);
    unsub();
    progressBus.publish({ stage: "success" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("removes all subscribers on clear", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    progressBus.subscribe(h1);
    progressBus.subscribe(h2);
    progressBus.clear();
    progressBus.publish({ stage: "success" });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("does not throw if handler throws", () => {
    const badHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const goodHandler = vi.fn();
    progressBus.subscribe(badHandler);
    progressBus.subscribe(goodHandler);

    expect(() => progressBus.publish({ stage: "success" })).not.toThrow();
    expect(goodHandler).toHaveBeenCalled();
  });
});
