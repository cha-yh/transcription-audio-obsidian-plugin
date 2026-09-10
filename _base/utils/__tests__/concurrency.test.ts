import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runWithConcurrency", () => {
  it("keeps results in input order regardless of completion order", async () => {
    const results = await runWithConcurrency(
      [
        () => new Promise<string>((r) => setTimeout(() => r("slow"), 20)),
        () => Promise.resolve("fast"),
      ],
      2
    );

    expect(results).toEqual([
      { status: "fulfilled", value: "slow" },
      { status: "fulfilled", value: "fast" },
    ]);
  });

  it("never runs more than the limit at once", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<number>());
    let running = 0;
    let peak = 0;

    const tasks = gates.map((gate, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      const value = await gate.promise;
      running--;
      return value;
    });

    const all = runWithConcurrency(tasks, 2);

    // Release one at a time; the pool should never have more than two started.
    for (const gate of gates) {
      gate.resolve(1);
      await Promise.resolve();
      await Promise.resolve();
    }

    await all;
    expect(peak).toBe(2);
  });

  it("collects rejections instead of failing the batch", async () => {
    const results = await runWithConcurrency(
      [
        () => Promise.resolve("ok"),
        () => Promise.reject(new Error("boom")),
        () => Promise.resolve("also ok"),
      ],
      2
    );

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: "fulfilled", value: "also ok" });
  });

  it("does not start a task before a slot frees up", async () => {
    const started: number[] = [];
    const gate = deferred<void>();

    const tasks = [
      async () => {
        started.push(0);
        await gate.promise;
      },
      async () => {
        started.push(1);
      },
    ];

    const all = runWithConcurrency(tasks, 1);
    await Promise.resolve();
    expect(started).toEqual([0]);

    gate.resolve();
    await all;
    expect(started).toEqual([0, 1]);
  });

  it("handles an empty task list", async () => {
    expect(await runWithConcurrency([], 4)).toEqual([]);
  });
});
