import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDebouncedRunner } from "../debounce";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDebouncedRunner", () => {
  it("collapses a burst into one run", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 1000);

    runner.schedule();
    runner.schedule();
    runner.schedule();
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restarts the delay on every call", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 1000);

    runner.schedule();
    vi.advanceTimersByTime(900);
    runner.schedule();
    vi.advanceTimersByTime(900);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs immediately on flush and drops the timer", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 1000);

    runner.schedule();
    runner.flush();
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing on flush when nothing is pending", () => {
    const run = vi.fn();
    createDebouncedRunner(run, 1000).flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("forgets the pending run on cancel", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 1000);

    runner.schedule();
    runner.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
