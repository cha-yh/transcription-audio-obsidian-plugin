/**
 * Runs tasks with at most `limit` of them in flight.
 *
 * Contract matches Promise.allSettled: results keep the order of the input and
 * the returned promise never rejects. The difference is that tasks are pulled
 * from the queue as slots free up, so nothing before a task's first await runs
 * until the task actually starts.
 */
export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return results;
}
