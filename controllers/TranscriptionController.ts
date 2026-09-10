import { App, Editor, Notice, TFile } from "obsidian";
import { ObsidianInteractorService } from "../_base/services/obsidian/ObsidianInteractorService";
import {
  TranscriptionResult,
  TranscriptionCancelledError,
  TranscriptionService,
  isTranscriptionCancelledError,
  isTranscriptionQuotaError,
  UploadedFileInfo,
  TranscriptionAudioSource,
} from "../_base/services/transcription/TranscriptionService";
import {
  computeWavChunkRanges,
  computeTimeBasedChunkRanges,
  computeSpeechAwareChunkPlan,
  PlannedChunk,
} from "../_base/services/transcription/chunking";
import {
  findSpeechIslands,
  speechRatioInRange,
} from "../_base/utils/speechActivity";
import { progressBus } from "../_base/utils/progressBus";
import { toBlob } from "../_base/utils/blob";
import { runWithConcurrency } from "../_base/utils/concurrency";
import {
  CHUNK_FAILED_PREFIX,
  CHUNK_PENDING_PREFIX,
  CHUNK_PLACEHOLDER_SUFFIX,
  hasChunkMarker,
  readChunkBody,
  replaceChunkBody,
  stripChunkMarkers,
  wrapChunkBody,
} from "../_base/utils/chunkMarkers";
import { ObsidianFileService } from "_base/services/obsidian/obsidianFileService";
import { AudioService, WavHeader } from "../_base/services/audio/AudioService";
import { AUDIO_FILE_REGEX } from "_base/constants/regex";
import { DEFAULT_TRANSCRIPTION_ONLY_PROMPT } from "_base/constants/setting";
import { TranscriptionCategory } from "_base/types/setting";

/** How long the classification/summarization steps wait for a manual retry. */
const RETRY_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How many chunks are transcribed at once. Unbounded parallelism started every
 * upload in the same tick, which a phone cannot hold and which spends the
 * Gemini rate limit in a burst — one quota error cancels the whole run.
 */
const MAX_CONCURRENT_CHUNKS = 4;
/** Decoded audio shorter than this goes up whole instead of being cut. */
const CHUNK_THRESHOLD_MS = 30 * 60 * 1000;
/** Segment length used when decoded audio is long enough to cut. */
const CHUNK_DURATION_MS = 20 * 60 * 1000;
function formatStamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Body written in place of a chunk that held no speech. Wrapped in `%%` so it
 * stays out of the rendered transcript, same as the chunk markers around it.
 */
function formatSkippedBody(startMs: number, endMs: number): string {
  return `%%[No speech detected — ${formatStamp(startMs)}–${formatStamp(
    endMs
  )} skipped]%%`;
}

type ChunkUsageContext = {
  chunkIndex: number;
  chunkTotal: number;
  displayIndex?: number;
  displayTotal?: number;
  retryable?: boolean;
};

/**
 * Numbering shown in the progress log, counting only the chunks that are
 * actually sent. Skipped ranges keep their planned index for the file markers
 * but must not inflate what the user sees as the total.
 */
function buildChunkDisplay(chunks: PlannedChunk[]): {
  displayTotal: number;
  displayIndexOf: (ci: number) => number | undefined;
} {
  const displayByCi = new Map<number, number>();
  let sent = 0;
  chunks.forEach((chunk, ci) => {
    if (chunk.skipped) return;
    sent += 1;
    displayByCi.set(ci, sent);
  });
  return {
    displayTotal: sent,
    displayIndexOf: (ci) => displayByCi.get(ci),
  };
}

/**
 * What a finished run leaves behind so that a single chunk can still be
 * re-transcribed from the progress log. Deliberately holds no decoded audio —
 * a 75-minute recording is ~137MB as 16kHz PCM, so the buffer is dropped and
 * re-derived from `audioPath` only when the uploaded file has expired.
 */
type ChunkRerunSession = {
  audioPath: string;
  transcriptPath: string;
  /** Full plan including skipped ranges, so display numbering can be rebuilt. */
  chunks: PlannedChunk[];
  model: string;
  apiKey: string;
  uploadedFiles: (UploadedFileInfo | null)[];
  inFlight: Set<number>;
  /**
   * Set when the run went up as one whole-file request. A re-run then has to
   * send the original file again rather than cutting a range out of it: the
   * range is the entire recording, and the file may not be decodable here at
   * all - which is exactly how it ended up on this path.
   */
  wholeFile?: { mimeType: string };
};

/**
 * Reads `category` out of a leading frontmatter block, unquoting the value the
 * way a YAML scalar would. Only a fallback for a cold metadata cache — the
 * search is confined to the block so a `category:` line in the transcript body
 * can never be mistaken for it.
 */
function readFrontmatterCategory(content: string): string | undefined {
  const block = content.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return undefined;

  const line = block[1].match(/^category:[ \t]*(.*)$/m);
  if (!line) return undefined;

  const value = line[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  return value.length > 0 ? value : undefined;
}

/** Everything a single transcription run needs from the plugin's settings. */
export interface TranscriptionRunOptions {
  apiKey: string | undefined;
  prompt: string;
  model: string;
  /** Whether the optional summarization step runs after transcription. */
  summarizeTranscript: boolean;
  enableCategoryClassification: boolean;
  categories: TranscriptionCategory[];
}

export class TranscriptionController {
  private writing: boolean = false;
  private obsidianFileService: ObsidianFileService = new ObsidianFileService(
    this.app
  );
  private obsidianInteractor: ObsidianInteractorService =
    new ObsidianInteractorService(this.app);
  private transcriptionService: TranscriptionService =
    new TranscriptionService();
  private audioService: AudioService = new AudioService();
  private isDevMode: boolean;
  private rerunSession: ChunkRerunSession | null = null;
  private unsubscribeRerun: () => void;

  constructor(private app: App, private progressViewType: string) {
    this.isDevMode = progressViewType.includes("-test");
    this.unsubscribeRerun = progressBus.subscribe((event) => {
      if (event.stage === "chunk-rerun-requested") {
        void this.rerunChunk(event.chunkIndex);
      }
    });
  }

  dispose(): void {
    this.unsubscribeRerun();
    this.rerunSession = null;
  }

  /**
   * Reports the speech profile without changing how the audio is chunked.
   * Used by the paths that cannot skip ranges — the inline WAV path has no
   * transcription file to write skip markers into, and a single-request
   * transcription has no chunks to drop.
   */
  private publishSpeechProfile(
    wavBuffer: ArrayBuffer,
    ranges: { startMs: number; endMs: number }[],
    totalMs: number
  ): void {
    try {
      const activity = this.audioService.analyzeWavSpeechActivity(wavBuffer);
      progressBus.publish({
        stage: "speech-activity",
        buckets: activity.buckets,
        totalMs,
        chunks: ranges.map((range, index) => ({
          chunkIndex: index + 1,
          startMs: range.startMs,
          endMs: range.endMs,
          speechRatio: speechRatioInRange(activity, range.startMs, range.endMs),
          skipped: false,
        })),
      });
    } catch (e) {
      console.warn(
        "[TranscriptionController] speech activity analysis failed",
        e
      );
    }
  }

  /**
   * Plans chunks around where speech actually is, and reports the profile for
   * the sparkline.
   *
   * Analysis is advisory: if it throws, planning falls back to plain
   * time-based chunking rather than failing the transcription.
   */
  private planChunks(
    wavBuffer: ArrayBuffer,
    totalMs: number,
    chunkDurationMs: number,
    overlapMs: number
  ): PlannedChunk[] {
    let plan: PlannedChunk[];
    let ratioFor: (chunk: PlannedChunk) => number = () => 0;
    let buckets: number[] = [];
    try {
      const activity = this.audioService.analyzeWavSpeechActivity(wavBuffer);
      const islands = findSpeechIslands(activity, totalMs);
      plan = computeSpeechAwareChunkPlan({
        totalMs,
        islands,
        chunkDurationMs,
        overlapMs,
      });
      ratioFor = (chunk) =>
        speechRatioInRange(activity, chunk.startMs, chunk.endMs);
      buckets = activity.buckets;
      if (this.isDevMode) {
        console.debug("[DEBUG] speech activity", {
          totalMs,
          frameMs: activity.frameMs,
          frames: activity.frames.length,
          speechRatio: activity.speechRatio,
          noiseFloor: activity.noiseFloor,
          peakRms: activity.peakRms,
          islands: islands.map((i) => [i.startMs, i.endMs]),
          plan: plan.map((c) => [c.startMs, c.endMs, c.skipped]),
        });
      }
    } catch (e) {
      console.warn(
        "[TranscriptionController] speech activity analysis failed",
        e
      );
      plan = computeTimeBasedChunkRanges({
        totalMs,
        chunkDurationMs,
        overlapMs,
      }).map((range) => ({ ...range, skipped: false }));
    }

    progressBus.publish({
      stage: "speech-activity",
      buckets,
      totalMs,
      chunks: plan.map((chunk, index) => ({
        chunkIndex: index + 1,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        speechRatio: ratioFor(chunk),
        skipped: chunk.skipped,
      })),
    });

    return plan;
  }

  private publishUsage(
    result: TranscriptionResult,
    chunk?: ChunkUsageContext
  ): void {
    progressBus.publish({
      stage: "api-usage",
      chunkIndex: chunk?.chunkIndex,
      chunkTotal: chunk?.chunkTotal,
      displayIndex: chunk?.displayIndex,
      displayTotal: chunk?.displayTotal,
      retryable: chunk?.retryable,
      promptTokenCount: result.usage.promptTokenCount,
      candidatesTokenCount: result.usage.candidatesTokenCount,
      thoughtsTokenCount: result.usage.thoughtsTokenCount,
      toolUsePromptTokenCount: result.usage.toolUsePromptTokenCount,
      totalTokenCount: result.usage.totalTokenCount,
    });
  }

  async run(editor: Editor, options: TranscriptionRunOptions): Promise<void> {
    const {
      apiKey,
      prompt,
      model,
      summarizeTranscript,
      enableCategoryClassification,
      categories,
    } = options;
    const currentCursorPosition = editor.getCursor();
    const activeFile = this.app.workspace.getActiveFile();

    if (activeFile == null) {
      new Notice("No active file found");
      return;
    }

    const textInRange = editor.getRange(
      { line: 0, ch: 0 },
      currentCursorPosition
    );

    const filePath = this.obsidianFileService.findFilePath(
      textInRange,
      AUDIO_FILE_REGEX
    );

    const fileType = filePath.split(".").pop();

    if (fileType == null || fileType == "") {
      new Notice("No audio file found");
      return;
    }

    if (this.writing) {
      new Notice("Generator is already in progress.");
      return;
    }

    if (!apiKey) {
      new Notice(
        "API Key is not configured. Please set it in the plugin settings."
      );
      return;
    }

    let cancelRequested = false;
    const abortController = new AbortController();
    const unsubscribeCancel = progressBus.subscribe((event) => {
      if (event.stage === "cancel-requested") {
        cancelRequested = true;
        abortController.abort();
      }
    });

    const throwIfCancelled = () => {
      if (cancelRequested || abortController.signal.aborted) {
        throw new TranscriptionCancelledError();
      }
    };

    let pendingTempFilePath: string | null = null;

    const cleanupTempFile = async () => {
      if (pendingTempFilePath) {
        const tempFile =
          this.app.vault.getAbstractFileByPath(pendingTempFilePath);
        if (tempFile instanceof TFile) {
          try {
            await this.app.vault.delete(tempFile);
          } catch {
            // ignore cleanup errors
          }
        }
        pendingTempFilePath = null;
      }
    };

    const publishUsage = (
      result: TranscriptionResult,
      chunk?: ChunkUsageContext
    ) => this.publishUsage(result, chunk);

    try {
      await this.openProgressView();

      throwIfCancelled();

      progressBus.publish({
        stage: "model-selected",
        model: model,
      });

      progressBus.publish({
        stage: "target-file-selected",
        path: activeFile.path,
        line: currentCursorPosition.line,
        ch: currentCursorPosition.ch,
      });

      progressBus.publish({ stage: "file-detected", fileName: filePath });
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file == null || !(file instanceof TFile))
        throw new Error(filePath + " does not exist");

      try {
        const audioBuffer = await this.app.vault.readBinary(file);

        throwIfCancelled();

        this.writing = true;
        // Retire the previous run's retry context so a stale Retry button can
        // never write into the file this run is about to produce.
        this.rerunSession = null;

        const mimeType = this.fileTypeToMimeType(fileType);

        progressBus.publish({
          stage: "file-size",
          sizeBytes: audioBuffer.byteLength,
        });

        try {
          // Check for existing transcription file
          const existingTranscript = await this.findExistingTranscription(
            filePath
          );

          let rawTranscript: string;
          let transcriptionFilePath: string | null = null;
          if (existingTranscript) {
            transcriptionFilePath = existingTranscript.path;
            // Skip transcription step, use existing file
            progressBus.publish({
              stage: "transcription-step-start",
            });
            rawTranscript = existingTranscript.text;
            progressBus.publish({
              stage: "transcription-step-complete",
              elapsedMs: 0,
            });
            progressBus.publish({
              stage: "temp-file-created",
              path: existingTranscript.path,
            });
          } else {
            // Step 1: Transcription
            const transcriptionStepStart = performance.now();
            progressBus.publish({ stage: "transcription-step-start" });

            // A PCM16 WAV is already what the chunker cuts, so it needs no
            // decode. Anything else is decoded once, for a duration to compare
            // and a WAV to cut; both stay null when the platform cannot decode
            // the format, and then the file goes up whole.
            const sourceIsPcm16Wav = this.isPcm16Wav(audioBuffer);
            let totalMs: number | null = null;
            let wavBuffer: ArrayBuffer | null = null;
            let sourceHeader: WavHeader | null = null;

            progressBus.publish({ stage: "preparing-audio" });

            if (sourceIsPcm16Wav) {
              try {
                // isPcm16Wav is satisfied by the fmt chunk alone, so a
                // truncated file can still land here and throw. Leaving both
                // values null sends it up whole, same as a failed decode.
                sourceHeader = this.audioService.parseWavHeader(audioBuffer);
                const bytesPerFrame =
                  sourceHeader.numChannels * (sourceHeader.bitsPerSample / 8);
                const totalFrames = Math.floor(
                  sourceHeader.dataSize / bytesPerFrame
                );
                totalMs = Math.floor(
                  (totalFrames / sourceHeader.sampleRate) * 1000
                );
                wavBuffer = audioBuffer;
              } catch (e) {
                progressBus.publish({
                  stage: "audio-decode-unavailable",
                  message: e instanceof Error ? e.message : String(e),
                });
              }
            } else {
              try {
                const decoded = await this.audioService.decodeToWavPcm16(
                  audioBuffer
                );
                wavBuffer = decoded.wavBuffer;
                totalMs = decoded.durationMs;
                if (this.isDevMode) {
                  console.debug(
                    `[DEBUG] WAV decoded: ${
                      wavBuffer.byteLength
                    } bytes, duration: ${totalMs}ms (${Math.round(
                      totalMs / 60000
                    )}min)`
                  );
                }
              } catch (e) {
                // platforms: WebKit rejects the Opus-in-MP4 that Chromium
                // decodes, which is what recordings made on desktop or
                // Android look like.
                progressBus.publish({
                  stage: "audio-decode-unavailable",
                  message: e instanceof Error ? e.message : String(e),
                });
              }
            }

            // How the ranges are chosen is the only thing the two sources
            // disagree on. A source WAV is cut by size, because its bitrate is
            // whatever the recorder chose and can be ten times the decoder's
            // 16 kHz mono — duration alone says little about how large one
            // request would be, so it is cut regardless of length. Anything
            // decoded is cut by speech-aware duration, and only once it is long
            // enough to be worth cutting. Everything after this point is shared.
            let chunkPlan: PlannedChunk[] | null = null;
            if (wavBuffer !== null && totalMs !== null) {
              if (sourceHeader !== null) {
                chunkPlan = computeWavChunkRanges({
                  dataSize: sourceHeader.dataSize,
                  sampleRate: sourceHeader.sampleRate,
                  bitsPerSample: sourceHeader.bitsPerSample,
                  numChannels: sourceHeader.numChannels,
                  targetChunkMB: 8,
                  overlapMs: 1500,
                }).map((range) => ({ ...range, skipped: false }));
                this.publishSpeechProfile(wavBuffer, chunkPlan, totalMs);
              } else if (totalMs >= CHUNK_THRESHOLD_MS) {
                chunkPlan = this.planChunks(
                  wavBuffer,
                  totalMs,
                  CHUNK_DURATION_MS,
                  1500
                );
              }
            }

            // No plan, or a plan with no ranges, means there is nothing to cut
            // and the file goes up whole.
            if (chunkPlan === null || chunkPlan.length === 0) {
              // Under 30 minutes: single request with original file.
              // No chunk ranges to report, but the profile is still useful.
              if (wavBuffer !== null && totalMs !== null) {
                this.publishSpeechProfile(wavBuffer, [], totalMs);
              }
              // The upload below sends the original file, so the decoded copy
              // is done with — releasing it before a request that can run for
              // minutes keeps it off the heap for that whole time.
              wavBuffer = null;

              // Numbered as a single chunk so that everything downstream —
              // the FAILED placeholder, the markers, the Retry button, the
              // rerun session — works the same as it does for a cut-up file.
              // Without this a short recording had no way to be retried: a
              // failure ended the run and left nothing to retry from.
              const wholeFileContext: ChunkUsageContext = {
                chunkIndex: 1,
                chunkTotal: 1,
                displayIndex: 1,
                displayTotal: 1,
                retryable: true,
              };
              let wholeFileUpload: UploadedFileInfo | null = null;
              let wholeFileError: string | null = null;

              let wholeFileText = "";
              try {
                const transcriptionResult =
                  await this.transcriptionService.transcribe(
                  apiKey!,
                  DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
                  {
                    kind: "upload",
                    blob: toBlob(audioBuffer, mimeType),
                    mimeType,
                  },
                  model,
                  6 * 60 * 1000,
                  () => {
                    progressBus.publish({ stage: "file-upload-start" });
                  },
                  (uploadElapsedMs, uploadedFile) => {
                    wholeFileUpload = uploadedFile;
                    progressBus.publish({
                      stage: "file-upload-complete",
                      elapsedMs: uploadElapsedMs,
                    });
                    if (this.isDevMode) {
                      console.debug(
                        `[DEBUG] Single transcription file uploaded:`,
                        {
                          uri: uploadedFile.uri,
                          mimeType: uploadedFile.mimeType,
                          expirationTime: uploadedFile.expirationTime,
                        }
                      );
                    }
                  },
                  () => {
                    progressBus.publish({ stage: "api-request-start" });
                  },
                  (apiRequestElapsedMs) => {
                    progressBus.publish({
                      stage: "api-request-complete",
                      elapsedMs: apiRequestElapsedMs,
                    });
                  },
                  abortController.signal,
                  true
                );

                if (transcriptionResult.uploadedFile) {
                  wholeFileUpload = transcriptionResult.uploadedFile;
                }
                publishUsage(transcriptionResult, wholeFileContext);
                wholeFileText = transcriptionResult.text.trim();
                if (wholeFileText.length === 0) {
                  wholeFileError = "Model returned an empty transcript.";
                }
              } catch (e) {
                // Cancellation and quota still end the run: one has already
                // been asked for, and the other cannot be retried usefully.
                if (
                  isTranscriptionCancelledError(e) ||
                  isTranscriptionQuotaError(e)
                ) {
                  throw e;
                }
                wholeFileError = e instanceof Error ? e.message : String(e);
              }

              if (wholeFileError !== null) {
                progressBus.publish({
                  stage: "chunk-failed",
                  ...wholeFileContext,
                  message: wholeFileError,
                });
              }

              // An empty transcript keeps the summary steps from running, the
              // same way a run whose every chunk failed does.
              rawTranscript = wholeFileError === null ? wholeFileText : "";

              const transcriptionStepElapsedMs = Math.round(
                performance.now() - transcriptionStepStart
              );
              progressBus.publish({
                stage: "transcription-step-complete",
                elapsedMs: transcriptionStepElapsedMs,
              });

              throwIfCancelled();

              // Wrapped in chunk markers even though there is only one, so the
              // region can be located and replaced by a later retry.
              const tempFilePath = await this.createTranscriptionTempFile(
                filePath,
                wrapChunkBody(
                  1,
                  wholeFileError === null
                    ? wholeFileText
                    : `${CHUNK_FAILED_PREFIX}1${CHUNK_PLACEHOLDER_SUFFIX}`
                )
              );
              transcriptionFilePath = await this.finalizeTranscriptionFile(
                tempFilePath
              );
              progressBus.publish({
                stage: "temp-file-created",
                path: transcriptionFilePath,
              });

              // Set after the rename for the same reason as the chunked path:
              // the write queue binds to a path and would no-op against _temp.
              this.rerunSession = {
                audioPath: filePath,
                transcriptPath: transcriptionFilePath,
                chunks: [
                  { startMs: 0, endMs: totalMs ?? 0, skipped: false },
                ],
                model,
                apiKey: apiKey!,
                uploadedFiles: [wholeFileUpload],
                inFlight: new Set<number>(),
                wholeFile: { mimeType },
              };

              if (wholeFileError !== null) {
                new Notice(
                  "Transcription failed. Retry it from the transcription progress panel."
                );
              }
            } else {
              const chunks = chunkPlan;

              // Chunks are cut from the Blob, not the ArrayBuffer: each
              // slice then references the audio instead of copying it. The
              // buffer is released here because planning was its last reader.
              const wavHeader = this.audioService.parseWavHeader(wavBuffer!);
              const wavBlob = new Blob([wavBuffer!], { type: "audio/wav" });
              wavBuffer = null;

              const chunkResults: string[] = new Array(chunks.length).fill(
                ""
              );
              const chunkUploadedFiles: (UploadedFileInfo | null)[] =
                new Array(chunks.length).fill(null);
              const failedChunkIndices: number[] = [];

              // Create temp file with PENDING placeholders, each already
              // wrapped in its chunk markers. The markers outlive the
              // placeholder so a finished chunk can still be located later.
              // Skipped ranges keep a numbered slot too, so the Retry button
              // can fill one in later if the silence detection was wrong.
              const pendingContent = chunks
                .map((chunk, i) =>
                  wrapChunkBody(
                    i + 1,
                    chunk.skipped
                      ? formatSkippedBody(chunk.startMs, chunk.endMs)
                      : `${CHUNK_PENDING_PREFIX}${i + 1}${CHUNK_PLACEHOLDER_SUFFIX}`
                  )
                )
                .join("\n\n");
              const tempFilePath = await this.createTranscriptionTempFile(
                filePath,
                pendingContent
              );
              pendingTempFilePath = tempFilePath;
              progressBus.publish({
                stage: "temp-file-created",
                path: tempFilePath,
              });

              const writeQueue = this.createFileWriteQueue(tempFilePath);

              const { displayTotal, displayIndexOf } =
                buildChunkDisplay(chunks);

              // Chunks run a few at a time; skipped ranges never reach the
              // model and are already written into the temp file.
              const chunkTasks = chunks
                .map((c, ci) => ({ c, ci }))
                .filter(({ c }) => !c.skipped)
                .map(
                  ({ c, ci }) =>
                    () =>
                      this.processChunk({
                        ci,
                        chunk: c,
                        chunkTotal: chunks.length,
                        wavBlob: wavBlob!,
                        wavHeader: wavHeader!,
                        apiKey: apiKey!,
                        model,
                        chunkResults,
                        chunkUploadedFiles,
                        failedChunkIndices,
                        writeQueue,
                        displayIndex: displayIndexOf(ci),
                        displayTotal,
                        abortSignal: abortController.signal,
                        publishUsage,
                      })
                );

              const chunkSettled = await runWithConcurrency(
                chunkTasks,
                MAX_CONCURRENT_CHUNKS
              );
              throwIfCancelled();

              // Check for quota errors — rethrow to cancel entire flow
              for (const result of chunkSettled) {
                if (
                  result.status === "rejected" &&
                  isTranscriptionQuotaError(result.reason)
                ) {
                  throw result.reason;
                }
              }

              const transcriptionStepElapsedMs = Math.round(
                performance.now() - transcriptionStepStart
              );
              progressBus.publish({
                stage: "transcription-step-complete",
                elapsedMs: transcriptionStepElapsedMs,
              });

              // Failed chunks stay in the file as FAILED placeholders and are
              // retried from the progress log afterwards. Blocking the run
              // until every failure is resolved used to discard the whole
              // transcription — including the chunks that succeeded — once the
              // wait timed out.
              if (failedChunkIndices.length > 0) {
                new Notice(
                  `${failedChunkIndices.length} chunk(s) failed. Retry them from the transcription progress panel.`
                );
              }

              // Build final transcript from results. Failed chunks contribute
              // nothing rather than leaking a placeholder into the summary.
              rawTranscript = chunkResults
                .filter((t) => t.length > 0)
                .join("\n\n");

              // Finalize: remove _temp from filename
              transcriptionFilePath = await this.finalizeTranscriptionFile(
                tempFilePath
              );
              pendingTempFilePath = null;
              progressBus.publish({
                stage: "temp-file-created",
                path: transcriptionFilePath,
              });

              // Keep just enough state to re-run a single chunk later. Set
              // only after the rename, since the write queue binds to a path
              // and would silently no-op against the old _temp name.
              this.rerunSession = {
                audioPath: filePath,
                transcriptPath: transcriptionFilePath,
                chunks,
                model,
                apiKey: apiKey!,
                uploadedFiles: chunkUploadedFiles,
                inFlight: new Set<number>(),
              };
            }
          }

          throwIfCancelled();

          // Build transcription file link
          const transcriptionLink = transcriptionFilePath
            ? `[[${transcriptionFilePath.split("/").pop()}]]`
            : "";

          // Steps 2 and 3 are optional; the transcript file above is not.
          // They are also pointless with nothing to summarize: every chunk can
          // fail, and asking the model to summarize an empty transcript bills
          // two requests to invent one.
          const transcriptForModel = stripChunkMarkers(rawTranscript);
          let transcript: string;
          if (!summarizeTranscript || transcriptForModel.length === 0) {
            transcript = transcriptionLink;
          } else {
            // Step 2: Classify transcript into a category when enabled
            let detectedCategory: string = "";
            let categoryPrompt: string = "";

            const hasEnabledCategories = categories.some((c) => c.enabled);

            if (!enableCategoryClassification) {
              // No classification — the default prompt summarizes everything
              categoryPrompt = prompt;
            } else if (existingTranscript?.category && hasEnabledCategories) {
              // Reuse category from existing transcription file
              detectedCategory = existingTranscript.category;
              progressBus.publish({ stage: "classification-step-start" });
              progressBus.publish({
                stage: "classification-step-complete",
                elapsedMs: 0,
                category: detectedCategory,
              });
            } else if (hasEnabledCategories) {
              detectedCategory = await this.runClassificationWithRetry(
                apiKey!,
                transcriptForModel,
                categories,
                model,
                transcriptionFilePath,
                abortController.signal,
                publishUsage
              );
            } else {
              detectedCategory = "";
            }

            // Resolve prompt: category prompt or fallback to user prompt
            if (!categoryPrompt) {
              if (detectedCategory && hasEnabledCategories) {
                const matchedCategory = categories.find(
                  (c) =>
                    c.enabled &&
                    c.name.toLowerCase() === detectedCategory.toLowerCase()
                );
                categoryPrompt = matchedCategory
                  ? matchedCategory.prompt
                  : prompt;
              } else {
                categoryPrompt = prompt;
              }
            }

            // Step 3: Summarization using category prompt
            const summarized = await this.runSummarizationWithRetry(
              apiKey!,
              categoryPrompt,
              transcriptForModel,
              model,
              abortController.signal,
              publishUsage
            );

            throwIfCancelled();

            transcript = transcriptionLink
              ? `${transcriptionLink}\n\n${summarized}`
              : summarized;
          }

          throwIfCancelled();

          await this.obsidianInteractor.appendTextToFile(
            activeFile.path,
            currentCursorPosition.line,
            currentCursorPosition.ch,
            transcript
          );

          // A run whose transcription produced nothing is not a success, even
          // though the transcript file and its link were still written. Also
          // covers reusing an existing transcript that holds only failed
          // placeholders, which is why the message claims no retry affordance.
          if (transcriptForModel.trim().length === 0) {
            progressBus.publish({
              stage: "error",
              message:
                "No transcript was produced, so summarization was skipped.",
            });
          } else {
            progressBus.publish({ stage: "success" });
          }
        } catch (e) {
          if (isTranscriptionCancelledError(e)) {
            await cleanupTempFile();
            new Notice("Transcription cancelled");
            progressBus.publish({ stage: "cancelled" });
            return;
          }

          if (isTranscriptionQuotaError(e)) {
            await cleanupTempFile();
            new Notice(e.status);
            progressBus.publish({
              stage: "error",
              message: `${e.status}: ${e.detail}`,
            });
            return;
          }

          console.error("[TranscriptionController] error", e);
          new Notice("Transcription failed");
          progressBus.publish({
            stage: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          this.writing = false;
          console.debug("[TranscriptionController] writing flag cleared");
        }
      } catch (error) {
        if (isTranscriptionCancelledError(error)) {
          await cleanupTempFile();
          new Notice("Transcription cancelled");
          progressBus.publish({ stage: "cancelled" });
          return;
        }

        console.error("[readBinary] error", error);
        new Notice("Transcription failed");
        progressBus.publish({ stage: "error", message: error.message });
      }
    } catch (error) {
      if (isTranscriptionCancelledError(error)) {
        await cleanupTempFile();
        new Notice("Transcription cancelled");
        progressBus.publish({ stage: "cancelled" });
        return;
      }

      console.warn(error.message);
      new Notice("Transcription failed");
      progressBus.publish({ stage: "error", message: error.message });
    } finally {
      unsubscribeCancel();
    }
  }

  private async runClassificationWithRetry(
    apiKey: string,
    rawTranscript: string,
    categories: TranscriptionCategory[],
    model: string,
    transcriptPath: string | null,
    abortSignal: AbortSignal,
    publishUsage: (result: TranscriptionResult) => void
  ): Promise<string> {
    const enabledCategories = categories.filter((c) => c.enabled);
    const categoryNames = enabledCategories.map((c) => c.name);

    const attempt = async (): Promise<string> => {
      const stepStart = performance.now();
      progressBus.publish({ stage: "classification-step-start" });

      const result = await this.transcriptionService.classifyTranscript(
        apiKey,
        rawTranscript,
        categoryNames,
        model,
        6 * 60 * 1000,
        () => progressBus.publish({ stage: "api-request-start" }),
        (ms) =>
          progressBus.publish({
            stage: "api-request-complete",
            elapsedMs: ms,
          }),
        abortSignal
      );

      publishUsage(result);

      const aiCategory = result.text.trim();
      const matched = categories.find(
        (c) => c.name.toLowerCase() === aiCategory.toLowerCase()
      );

      let detectedCategory: string;
      if (matched) {
        detectedCategory = matched.name;
        await this.writeTranscriptCategory(transcriptPath, detectedCategory);
      } else {
        // An unrecognized category intentionally falls back to the user's
        // default prompt instead of a synthetic "General" category.
        detectedCategory = "";
        await this.writeTranscriptCategory(
          transcriptPath,
          `Default prompt (AI suggested: ${aiCategory})`
        );
      }

      const elapsedMs = Math.round(performance.now() - stepStart);
      progressBus.publish({
        stage: "classification-step-complete",
        elapsedMs,
        category: detectedCategory,
      });

      return detectedCategory;
    };

    // First attempt
    try {
      return await attempt();
    } catch (e) {
      if (isTranscriptionCancelledError(e)) throw e;
      if (isTranscriptionQuotaError(e)) throw e;

      progressBus.publish({
        stage: "classification-step-failed",
        message: e instanceof Error ? e.message : String(e),
      });

      return await this.waitForRetryEvent(
        "classification-retry-requested",
        attempt
      );
    }
  }

  private async runSummarizationWithRetry(
    apiKey: string,
    categoryPrompt: string,
    rawTranscript: string,
    model: string,
    abortSignal: AbortSignal,
    publishUsage: (result: TranscriptionResult) => void
  ): Promise<string> {
    const attempt = async (): Promise<string> => {
      const stepStart = performance.now();
      progressBus.publish({ stage: "summarization-step-start" });

      const result = await this.transcriptionService.summarizeText(
        apiKey,
        categoryPrompt,
        rawTranscript,
        model,
        6 * 60 * 1000,
        () => progressBus.publish({ stage: "api-request-start" }),
        (ms) =>
          progressBus.publish({
            stage: "api-request-complete",
            elapsedMs: ms,
          }),
        abortSignal
      );

      publishUsage(result);

      const elapsedMs = Math.round(performance.now() - stepStart);
      progressBus.publish({
        stage: "summarization-step-complete",
        elapsedMs,
      });

      return result.text;
    };

    // First attempt
    try {
      return await attempt();
    } catch (e) {
      if (isTranscriptionCancelledError(e)) throw e;
      if (isTranscriptionQuotaError(e)) throw e;

      progressBus.publish({
        stage: "summarization-step-failed",
        message: e instanceof Error ? e.message : String(e),
      });

      return await this.waitForRetryEvent(
        "summarization-retry-requested",
        attempt
      );
    }
  }

  private async waitForRetryEvent<T>(
    eventStage: string,
    retryFn: () => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      let settled = false;

      const stopListening = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };

      const settleResolve = (value: T) => {
        if (settled) return;
        settled = true;
        stopListening();
        resolve(value);
      };

      const settleReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        stopListening();
        reject(error);
      };

      const retryLabel = eventStage
        .replace("-retry-requested", "")
        .replace(/-/g, " ");

      timeoutId = setTimeout(() => {
        settleReject(
          new Error(
            `No ${retryLabel} retry requested within ${
              RETRY_WAIT_TIMEOUT_MS / 60000
            } minutes.`
          )
        );
      }, RETRY_WAIT_TIMEOUT_MS);

      unsubscribe = progressBus.subscribe(async (event) => {
        if (event.stage === "cancel-requested") {
          settleReject(new TranscriptionCancelledError());
          return;
        }

        if (event.stage !== eventStage) return;

        stopListening();

        try {
          const result = await retryFn();
          settleResolve(result);
        } catch (retryError) {
          if (
            isTranscriptionCancelledError(retryError) ||
            isTranscriptionQuotaError(retryError)
          ) {
            settleReject(retryError);
            return;
          }
          // Failed again — publish failure and wait for next retry
          const failedStage = eventStage.replace(
            "-retry-requested",
            "-step-failed"
          );
          progressBus.publish({
            stage: failedStage as any,
            message:
              retryError instanceof Error
                ? retryError.message
                : String(retryError),
          });

          this.waitForRetryEvent(eventStage, retryFn).then(
            settleResolve,
            settleReject
          );
        }
      });
    });
  }

  private createFileWriteQueue(tempFilePath: string) {
    let chain = Promise.resolve();
    return {
      enqueue: (replaceFn: (data: string) => string): Promise<void> => {
        chain = chain.then(async () => {
          try {
            const file = this.app.vault.getAbstractFileByPath(tempFilePath);
            if (file instanceof TFile) {
              await this.app.vault.process(file, replaceFn);
            }
          } catch (e) {
            console.error("[writeQueue] Failed to update temp file:", e);
          }
        });
        return chain;
      },
    };
  }

  private async processChunk(params: {
    ci: number;
    chunk: { startMs: number; endMs: number };
    chunkTotal: number;
    wavBlob: Blob;
    wavHeader: WavHeader;
    apiKey: string;
    model: string;
    chunkResults: string[];
    chunkUploadedFiles: (UploadedFileInfo | null)[];
    failedChunkIndices: number[];
    writeQueue: ReturnType<typeof this.createFileWriteQueue>;
    displayIndex?: number;
    displayTotal: number;
    abortSignal: AbortSignal;
    publishUsage: (
      result: TranscriptionResult,
      chunk?: ChunkUsageContext
    ) => void;
  }): Promise<void> {
    const {
      ci,
      chunk: c,
      chunkTotal,
      wavBlob,
      wavHeader,
      apiKey,
      model,
      chunkResults,
      chunkUploadedFiles,
      failedChunkIndices,
      writeQueue,
      displayIndex,
      displayTotal,
      abortSignal,
      publishUsage,
    } = params;

    const chunkIndex = ci + 1;
    const chunkContext = {
      chunkIndex,
      chunkTotal,
      displayIndex,
      displayTotal,
      retryable: true,
    };
    const failedPlaceholder = `${CHUNK_FAILED_PREFIX}${chunkIndex}${CHUNK_PLACEHOLDER_SUFFIX}`;

    // Queued chunks can still be waiting when the run is cancelled. Without
    // this they would announce themselves and cut their audio first, only to
    // die on the upload.
    if (abortSignal.aborted) {
      throw new TranscriptionCancelledError();
    }

    progressBus.publish({
      stage: "chunk-start",
      ...chunkContext,
      startMs: c.startMs,
      endMs: c.endMs,
    });

    const chunkBlob = this.audioService.sliceWavPcm16ToBlob(
      wavBlob,
      wavHeader,
      c.startMs,
      c.endMs
    );

    try {
      const result = await this.transcriptionService.transcribe(
        apiKey,
        DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
        { kind: "upload", blob: chunkBlob, mimeType: "audio/wav" },
        model,
        6 * 60 * 1000,
        () => {
          progressBus.publish({ stage: "file-upload-start", ...chunkContext });
        },
        (uploadElapsedMs, uploadedFile) => {
          chunkUploadedFiles[ci] = uploadedFile;
          progressBus.publish({
            stage: "file-upload-complete",
            ...chunkContext,
            elapsedMs: uploadElapsedMs,
          });
          if (this.isDevMode) {
            console.debug(`[DEBUG] Chunk ${chunkIndex} file uploaded:`, {
              uri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType,
              expirationTime: uploadedFile.expirationTime,
            });
          }
        },
        () => {
          progressBus.publish({ stage: "api-request-start", ...chunkContext });
        },
        (apiRequestElapsedMs) => {
          progressBus.publish({
            stage: "api-request-complete",
            ...chunkContext,
            elapsedMs: apiRequestElapsedMs,
          });
        },
        abortSignal,
        true
      );

      if (this.isDevMode) {
        console.debug(
          `[DEBUG] Chunk ${chunkIndex} response length: ${
            result.text.length
          }, content: ${JSON.stringify(result.text.substring(0, 100))}`
        );
      }

      publishUsage(result, chunkContext);

      const trimmedText = result.text.trim();

      if (trimmedText.length < 50) {
        progressBus.publish({
          stage: "chunk-short-response",
          chunkIndex,
          chunkTotal,
          displayIndex,
          displayTotal,
          charCount: trimmedText.length,
        });
      }

      chunkResults[ci] = trimmedText;

      // Update temp file: replace the marked chunk body with the actual text
      await writeQueue.enqueue((data: string) => {
        const next = replaceChunkBody(data, chunkIndex, trimmedText);
        if (next === null) {
          console.warn(
            `[TranscriptionController] chunk ${chunkIndex} markers missing; temp file left unchanged`
          );
          return data;
        }
        return next;
      });

      progressBus.publish({
        stage: "chunk-complete",
        chunkIndex,
        chunkTotal,
        displayIndex,
        displayTotal,
      });
    } catch (e) {
      if (isTranscriptionCancelledError(e) || isTranscriptionQuotaError(e)) {
        throw e;
      }

      failedChunkIndices.push(ci);
      // Left empty so the placeholder never reaches the summary; the file keeps
      // the FAILED marker so the chunk can be retried later.
      chunkResults[ci] = "";

      // Update temp file: mark the chunk body as FAILED, markers intact
      await writeQueue.enqueue(
        (data: string) =>
          replaceChunkBody(data, chunkIndex, failedPlaceholder) ?? data
      );

      progressBus.publish({
        stage: "chunk-failed",
        chunkIndex,
        chunkTotal,
        displayIndex,
        displayTotal,
        message: e?.message || String(e),
      });
    }
  }

  private isUploadedFileValid(file: UploadedFileInfo | null): boolean {
    if (!file?.uri || !file?.mimeType) return false;
    if (!file.expirationTime) return false;
    const expiration = new Date(file.expirationTime).getTime();
    // Consider invalid if less than 1 minute remaining
    return expiration > Date.now() + 60 * 1000;
  }

  /**
   * Reveals the progress panel, creating it in the right sidebar when it is
   * not open. Also reachable as a command, so the panel and its stored run
   * history can be brought back without starting a transcription.
   */
  async openProgressView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(this.progressViewType);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const rightSplit = this.app.workspace.getRightLeaf(false);
    if (rightSplit) {
      await rightSplit.setViewState({
        type: this.progressViewType,
        active: true,
      });
      this.app.workspace.revealLeaf(rightSplit);
    } else {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({
        type: this.progressViewType,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private fileTypeToMimeType(ext: string | undefined): string {
    const map: Record<string, string> = {
      webm: "audio/webm",
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      m4a: "audio/mp4",
      wav: "audio/wav",
      mpeg: "audio/mpeg",
      mpga: "audio/mpeg",
    };
    if (!ext) return "application/octet-stream";
    return map[ext.toLowerCase()] || "application/octet-stream";
  }

  private async findExistingTranscription(
    audioFilePath: string
  ): Promise<{ path: string; text: string; category?: string } | null> {
    const audioName =
      audioFilePath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") || "";
    if (!audioName) return null;

    const audioDir = audioFilePath.includes("/")
      ? audioFilePath.substring(0, audioFilePath.lastIndexOf("/"))
      : "";
    const prefix = `_transcription_${audioName}_`;

    const allFiles = this.app.vault.getFiles();
    const candidates = allFiles
      .filter((f) => {
        const dir = f.path.includes("/")
          ? f.path.substring(0, f.path.lastIndexOf("/"))
          : "";
        const name = f.path.split("/").pop() || "";
        return (
          dir === audioDir &&
          name.startsWith(prefix) &&
          name.endsWith(".md") &&
          !name.endsWith("_temp.md")
        );
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (candidates.length === 0) return null;

    const file = candidates[0];
    const content = await this.app.vault.read(file);

    // Prefer the metadata cache, so the value arrives unquoted however Obsidian
    // chose to serialize it. Right after startup the cache can still be cold,
    // and `content` is already in hand, so fall back to the frontmatter block
    // rather than paying for a classification the file already answers.
    const cachedCategory =
      this.app.metadataCache.getFileCache(file)?.frontmatter?.category;
    const category =
      typeof cachedCategory === "string" && cachedCategory.trim().length > 0
        ? cachedCategory.trim()
        : readFrontmatterCategory(content);

    // Extract transcription text after "## Transcription\n\n"
    const marker = "## Transcription\n\n";
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) return null;

    // A transcription file can be finalized with unresolved chunks, and always
    // carries the chunk markers that make retry possible. Neither belongs in
    // what gets handed back to the model.
    const text = stripChunkMarkers(
      content.substring(markerIndex + marker.length)
    );
    if (text.length === 0) return null;

    return { path: file.path, text, category };
  }

  /**
   * Stamps the detected category onto the transcript file so a later run can
   * reuse it. Obsidian owns the YAML: the category is unvalidated model output,
   * and a bare `: ` or a line break in it would make a hand-written frontmatter
   * line unparseable — while a hand-written regex would just as happily rewrite
   * a `category:` line that appears in the transcript body instead.
   */
  private async writeTranscriptCategory(
    transcriptPath: string | null,
    category: string
  ): Promise<void> {
    if (!transcriptPath) return;

    const file = this.app.vault.getAbstractFileByPath(transcriptPath);
    if (!file || !(file instanceof TFile)) return;

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.category = category;
      });
    } catch (e) {
      // processFrontMatter throws on a block it cannot parse — a file edited by
      // hand, or written by a release that did not quote the audio path. The
      // category is only a reuse optimization, so losing it must not fail the
      // classification step that has already been paid for.
      console.warn(
        "[TranscriptionController] could not write the transcript category",
        e
      );
    }
  }

  private async finalizeTranscriptionFile(
    tempFilePath: string
  ): Promise<string> {
    const finalPath = tempFilePath.replace(/_temp\.md$/, ".md");
    const file = this.app.vault.getAbstractFileByPath(tempFilePath);
    if (file instanceof TFile) {
      await this.app.vault.rename(file, finalPath);
    }
    return finalPath;
  }

  private async createTranscriptionTempFile(
    audioFilePath: string,
    transcription: string
  ): Promise<string> {
    const audioName =
      audioFilePath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") || "audio";
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const tempFileName = `_transcription_${audioName}_${timestamp}_temp.md`;

    const audioDir = audioFilePath.includes("/")
      ? audioFilePath.substring(0, audioFilePath.lastIndexOf("/"))
      : "";
    const tempFilePath = audioDir
      ? `${audioDir}/${tempFileName}`
      : tempFileName;

    // JSON string syntax is a subset of YAML's double-quoted scalar, so this
    // stays parseable for a path holding `: `, a quote or a backslash — which
    // matters because processFrontMatter throws on a frontmatter block it
    // cannot parse.
    const content =
      `---\naudio: ${JSON.stringify(audioFilePath)}\n` +
      `created: ${new Date().toISOString()}\n---\n\n` +
      `## Transcription\n\n${transcription}\n`;

    await this.app.vault.create(tempFilePath, content);
    return tempFilePath;
  }

  /**
   * Rebuilds one chunk's audio from the original file. Only needed when the
   * uploaded file has expired — otherwise the cached URI is reused and the
   * audio never has to be decoded again.
   */
  private async buildChunkBlob(
    audioPath: string,
    range: { startMs: number; endMs: number }
  ): Promise<Blob> {
    const audioFile = this.app.vault.getAbstractFileByPath(audioPath);
    if (!(audioFile instanceof TFile)) {
      throw new Error(`Original audio file not found: ${audioPath}`);
    }

    progressBus.publish({ stage: "preparing-audio" });
    const buffer = await this.app.vault.readBinary(audioFile);
    const wavBuffer = this.isPcm16Wav(buffer)
      ? buffer
      : (await this.audioService.decodeToWavPcm16(buffer)).wavBuffer;
    return toBlob(
      this.audioService.sliceWavPcm16(wavBuffer, range.startMs, range.endMs),
      "audio/wav"
    );
  }

  /** The original audio, untouched — no decoding, no slicing. */
  private async readAudioBlob(
    audioPath: string,
    mimeType: string
  ): Promise<Blob> {
    const file = this.app.vault.getAbstractFileByPath(audioPath);
    if (!(file instanceof TFile)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }
    return toBlob(await this.app.vault.readBinary(file), mimeType);
  }

  /**
   * Re-transcribes a chunk that already produced text, replacing just that
   * chunk's marked region in the transcription file. Triggered by the Retry
   * button in the progress log, so it runs outside the original `run()` call.
   */
  private async rerunChunk(chunkIndex: number): Promise<void> {
    const session = this.rerunSession;
    const chunkTotal = session?.chunks.length ?? 0;

    const publishFailure = (message: string) => {
      progressBus.publish({
        stage: "chunk-rerun-complete",
        chunkIndex,
        chunkTotal,
        success: false,
        message,
      });
    };

    // No `this.writing` guard: the session is cleared at the start of every run
    // and only set once the file has been finalized, so a null session already
    // covers "a transcription is in flight". Checking `writing` on top of that
    // would refuse retries during summarization, when the transcription file is
    // finished and safe to rewrite.
    if (!session) {
      publishFailure(
        "Retry is unavailable until the transcription file has been written."
      );
      return;
    }

    const ci = chunkIndex - 1;
    if (ci < 0 || ci >= session.chunks.length) {
      publishFailure(`Unknown chunk ${chunkIndex}.`);
      return;
    }
    if (session.inFlight.has(ci)) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(session.transcriptPath);
    if (!(file instanceof TFile)) {
      publishFailure(`Transcription file not found: ${session.transcriptPath}`);
      return;
    }

    const currentData = await this.app.vault.read(file);
    if (!hasChunkMarker(currentData, chunkIndex)) {
      publishFailure(
        `Chunk ${chunkIndex} markers are missing from the transcription file.`
      );
      return;
    }
    const previousLength = (readChunkBody(currentData, chunkIndex) ?? "")
      .length;

    const range = session.chunks[ci];
    // Skipped ranges have no display slot, so a re-run of one falls back to the
    // planned numbering rather than inventing a position among the sent chunks.
    const { displayTotal, displayIndexOf } = buildChunkDisplay(session.chunks);
    const chunkContext: ChunkUsageContext = {
      chunkIndex,
      chunkTotal,
      displayIndex: displayIndexOf(ci),
      displayTotal,
      retryable: true,
    };

    session.inFlight.add(ci);
    progressBus.publish({
      stage: "chunk-start",
      ...chunkContext,
      startMs: range.startMs,
      endMs: range.endMs,
    });

    try {
      const cached = session.uploadedFiles[ci];
      // Rebuilding the chunk re-reads and re-decodes the whole file, so it only
      // happens when the cached upload is gone.
      const audio: TranscriptionAudioSource = this.isUploadedFileValid(cached)
        ? { kind: "cached", file: cached! }
        : {
            kind: "upload",
            // A run that went up whole is re-sent whole. Cutting a range would
            // need the decoder, which this path may not have had to begin with.
            blob: session.wholeFile
              ? await this.readAudioBlob(
                  session.audioPath,
                  session.wholeFile.mimeType
                )
              : await this.buildChunkBlob(session.audioPath, range),
            mimeType: session.wholeFile
              ? session.wholeFile.mimeType
              : "audio/wav",
          };

      const result = await this.transcriptionService.transcribe(
        session.apiKey,
        DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
        audio,
        session.model,
        6 * 60 * 1000,
        () => {
          progressBus.publish({ stage: "file-upload-start", ...chunkContext });
        },
        (uploadElapsedMs, uploadedFile) => {
          session.uploadedFiles[ci] = uploadedFile;
          progressBus.publish({
            stage: "file-upload-complete",
            ...chunkContext,
            elapsedMs: uploadElapsedMs,
          });
        },
        () => {
          progressBus.publish({ stage: "api-request-start", ...chunkContext });
        },
        (apiRequestElapsedMs) => {
          progressBus.publish({
            stage: "api-request-complete",
            ...chunkContext,
            elapsedMs: apiRequestElapsedMs,
          });
        },
        undefined,
        true
      );

      if (result.uploadedFile) {
        session.uploadedFiles[ci] = result.uploadedFile;
      }

      this.publishUsage(result, chunkContext);

      const trimmedText = result.text.trim();
      if (trimmedText.length === 0) {
        publishFailure("Model returned an empty transcript.");
        return;
      }

      let replaced = false;
      const writeQueue = this.createFileWriteQueue(session.transcriptPath);
      await writeQueue.enqueue((data: string) => {
        const next = replaceChunkBody(data, chunkIndex, trimmedText);
        if (next === null) {
          return data;
        }
        replaced = true;
        return next;
      });

      if (!replaced) {
        publishFailure(
          `Chunk ${chunkIndex} markers disappeared before the rewrite.`
        );
        return;
      }

      progressBus.publish({
        stage: "chunk-rerun-complete",
        chunkIndex,
        chunkTotal,
        displayIndex: chunkContext.displayIndex,
        displayTotal,
        success: true,
        previousLength,
        newLength: trimmedText.length,
      });
    } catch (e) {
      publishFailure(e instanceof Error ? e.message : String(e));
    } finally {
      session.inFlight.delete(ci);
    }
  }

  private isPcm16Wav(buffer: ArrayBuffer): boolean {
    try {
      const view = new DataView(buffer);
      const tag = (o: number) =>
        String.fromCharCode(
          view.getUint8(o),
          view.getUint8(o + 1),
          view.getUint8(o + 2),
          view.getUint8(o + 3)
        );
      if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return false;
      let offset = 12;
      while (offset + 8 <= view.byteLength) {
        const id = tag(offset);
        const size = view.getUint32(offset + 4, true);
        if (id === "fmt ") {
          const format = view.getUint16(offset + 8, true);
          const bits = view.getUint16(offset + 22, true);
          return format === 1 && bits === 16;
        }
        offset += 8 + size + (size % 2);
      }
      return false;
    } catch {
      return false;
    }
  }
}
