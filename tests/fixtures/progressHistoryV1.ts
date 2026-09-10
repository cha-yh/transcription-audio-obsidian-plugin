/**
 * A real v1 history file, kept as the golden input for migration tests.
 *
 * Do not delete this when a v2 arrives — add `progressHistoryV2.ts` beside it
 * and keep this one as the v1 → v2 input. Dropping old fixtures is how a new
 * migration quietly breaks an old one.
 *
 * A `.ts` module rather than `.json`: the tsconfig has no `resolveJsonModule`
 * and `isolatedModules` is on, so a JSON import fails `yarn typecheck`.
 */
export const progressHistoryV1 = {
  version: 1,
  sessions: [
    {
      id: "m2x1k0-1",
      startedAtMs: 1757480652000,
      endedAtMs: 1757480853000,
      status: "success",
      statusText: "Success",
      latestLogText: "Success: total 3:21",
      fileSizeText: "12.4 MB",
      modelText: "gemini-3.7-flash",
      cancelLabel: "done",
      categoryText: "Tech Meeting",
      transcriptPath: "Recordings/standup.md",
      audioPath: "Recordings/standup.m4a",
      audioName: "standup.m4a",
      targetPath: "Notes/daily.md",
      targetLine: 12,
      targetCh: 0,
      isCancellable: false,
      isLogExpanded: false,
      chunk: {
        total: 3,
        index: 3,
        completed: 3,
        barMax: 3,
        barValue: 3,
        labelText: "3/3 done",
      },
      logHistory: [
        { text: "Log start: Sep 10, 2026, 12:04:12 PM" },
        { text: "File detected: standup.m4a" },
        {
          text: "Speech analysed - 3 chunk(s) to transcribe",
          sparkline: {
            buckets: [0, 0.25, 0.812, 1, 0.04],
            totalMs: 1800000,
            chunks: [
              {
                chunkIndex: 1,
                startMs: 0,
                endMs: 600000,
                speechRatio: 0.62,
                skipped: false,
              },
              {
                chunkIndex: 2,
                startMs: 600000,
                endMs: 1200000,
                speechRatio: 0.01,
                skipped: true,
              },
            ],
          },
        },
        { text: "1/2 - Chunk complete", retryChunkIndex: 1 },
        { text: "Success: total 3:21" },
      ],
      failedChunks: [],
    },
    {
      id: "m2x0zz-0",
      startedAtMs: 1757394252000,
      endedAtMs: 1757394300000,
      status: "error",
      statusText: "Failed",
      latestLogText: "API request failed - click detail for more",
      fileSizeText: "3.1 MB",
      modelText: "gemini-3.6-flash",
      cancelLabel: "failed",
      audioPath: "Recordings/memo.m4a",
      audioName: "memo.m4a",
      isCancellable: false,
      isLogExpanded: true,
      logHistory: [
        { text: "Log start: Sep 9, 2026, 12:04:12 PM" },
        { text: "Failed: 429 rate limited" },
      ],
      failedChunks: [2, 1],
    },
  ],
};
