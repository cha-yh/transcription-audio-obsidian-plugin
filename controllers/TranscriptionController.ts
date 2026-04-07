import { App, Editor, Notice, TFile } from "obsidian";
import { ObsidianInteractorService } from "../_base/services/obsidian/ObsidianInteractorService";
import {
  TranscriptionResult,
  TranscriptionCancelledError,
  TranscriptionService,
  isTranscriptionCancelledError,
  UploadedFileInfo,
} from "../_base/services/transcription/TranscriptionService";
import {
  computeWavChunkRanges,
  computeTimeBasedChunkRanges,
} from "../_base/services/transcription/chunking";
import { progressBus } from "../_base/utils/progressBus";
import { ObsidianFileService } from "_base/services/obsidian/obsidianFileService";
import { AudioService } from "../_base/services/audio/AudioService";
import { AUDIO_FILE_REGEX } from "_base/constants/regex";
import {
  DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
  GENERAL_CATEGORY_ID,
} from "_base/constants/setting";
import { TranscriptionCategory } from "_base/types/setting";

const CHUNK_TRANSCRIPTION_PROMPT =
  "Transcribe the following audio. Output only the transcript text for this part, without any extra commentary.";

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

  constructor(private app: App, private progressViewType: string) {
    this.isDevMode = progressViewType.includes("-test");
  }

  async run(
    editor: Editor,
    apiKey: string | undefined,
    prompt: string,
    model: string,
    outputTemplate: string,
    enableTranscribeThenSummarize: boolean = false,
    enableCategoryClassification: boolean = false,
    categories: TranscriptionCategory[] = []
  ): Promise<void> {
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

    const normalizedTemplate = outputTemplate.trim();
    const hasOutputTemplate = normalizedTemplate.length > 0;

    const templateModePrompt = hasOutputTemplate
      ? `${prompt}\n\nUse the following markdown template exactly when generating output:\n${normalizedTemplate}\n\nRules:\n- Output only the final filled markdown template.\n- Preserve heading order, heading titles, list/checklist style, and section structure exactly.\n- If a section cannot be filled from audio, write N/A.`
      : prompt;

    const publishUsage = (result: TranscriptionResult) => {
      progressBus.publish({
        stage: "api-usage",
        promptTokenCount: result.usage.promptTokenCount,
        candidatesTokenCount: result.usage.candidatesTokenCount,
        thoughtsTokenCount: result.usage.thoughtsTokenCount,
        toolUsePromptTokenCount: result.usage.toolUsePromptTokenCount,
        totalTokenCount: result.usage.totalTokenCount,
      });
    };

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

        const mimeType = this.fileTypeToMimeType(fileType);

        progressBus.publish({
          stage: "file-size",
          sizeBytes: audioBuffer.byteLength,
        });

        try {
          let transcript: string;
          if (this.isPcm16Wav(audioBuffer) && !hasOutputTemplate) {
            progressBus.publish({ stage: "preparing-audio" });
            const header = this.audioService.parseWavHeader(audioBuffer);
            const chunks = computeWavChunkRanges({
              dataSize: header.dataSize,
              sampleRate: header.sampleRate,
              bitsPerSample: header.bitsPerSample,
              numChannels: header.numChannels,
              targetChunkMB: 8,
              overlapMs: 1500,
            });
            let combined = "";
            let index = 0;
            for (const c of chunks) {
              throwIfCancelled();

              index++;
              progressBus.publish({
                stage: "chunk-start",
                chunkIndex: index,
                chunkTotal: chunks.length,
              });
              const chunkBuffer = this.audioService.sliceWavPcm16(
                audioBuffer,
                c.startMs,
                c.endMs
              );
              const preface = `\n\n[Part ${index}/${chunks.length}]\n`;
              try {
                const chunkBase64 =
                  await this.audioService.arrayBufferToBase64Async(chunkBuffer);
                const result = await this.transcriptionService.transcribe(
                  apiKey!,
                  CHUNK_TRANSCRIPTION_PROMPT,
                  chunkBase64,
                  "audio/wav",
                  model,
                  6 * 60 * 1000,
                  () => {
                    progressBus.publish({ stage: "file-upload-start" });
                  },
                  (uploadElapsedMs, uploadedFile) => {
                    progressBus.publish({
                      stage: "file-upload-complete",
                      elapsedMs: uploadElapsedMs,
                    });
                    if (this.isDevMode) {
                      console.debug(`[DEBUG] Chunk ${index} file uploaded:`, {
                        uri: uploadedFile.uri,
                        mimeType: uploadedFile.mimeType,
                        expirationTime: uploadedFile.expirationTime,
                      });
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

                publishUsage(result);

                const text = result.text;

                throwIfCancelled();

                combined += preface + text.trim();
                progressBus.publish({
                  stage: "chunk-complete",
                  chunkIndex: index,
                  chunkTotal: chunks.length,
                });
              } catch (e) {
                if (isTranscriptionCancelledError(e)) {
                  throw e;
                }

                progressBus.publish({
                  stage: "chunk-failed",
                  chunkIndex: index,
                  chunkTotal: chunks.length,
                  message: e?.message || String(e),
                });
                combined +=
                  preface +
                  `[[Chunk ${index} failed: ${e?.message || String(e)}]]`;
              }
            }
            transcript = combined.trim();
          } else if (enableTranscribeThenSummarize) {
            const CHUNK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
            const CHUNK_DURATION_MS = 20 * 60 * 1000; // 20 minutes

            // Check for existing transcription file
            const existingTranscript = await this.findExistingTranscription(
              filePath
            );

            let rawTranscript: string;
            if (existingTranscript) {
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

              // Decode once to determine duration and get WAV for chunking
              let totalMs: number;
              let wavBuffer: ArrayBuffer | null = null;

              if (this.isPcm16Wav(audioBuffer)) {
                const header = this.audioService.parseWavHeader(audioBuffer);
                const bytesPerFrame =
                  header.numChannels * (header.bitsPerSample / 8);
                const totalFrames = Math.floor(header.dataSize / bytesPerFrame);
                totalMs = Math.floor((totalFrames / header.sampleRate) * 1000);
                wavBuffer = audioBuffer;
              } else {
                progressBus.publish({ stage: "preparing-audio" });
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
              }

              if (totalMs < CHUNK_THRESHOLD_MS) {
                // Under 30 minutes: single request with original file
                const audioBase64 =
                  await this.audioService.arrayBufferToBase64Async(audioBuffer);
                const transcriptionResult =
                  await this.transcriptionService.transcribe(
                    apiKey!,
                    DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
                    audioBase64,
                    mimeType,
                    model,
                    6 * 60 * 1000,
                    () => {
                      progressBus.publish({ stage: "file-upload-start" });
                    },
                    (uploadElapsedMs, uploadedFile) => {
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

                publishUsage(transcriptionResult);
                rawTranscript = transcriptionResult.text;

                const transcriptionStepElapsedMs = Math.round(
                  performance.now() - transcriptionStepStart
                );
                progressBus.publish({
                  stage: "transcription-step-complete",
                  elapsedMs: transcriptionStepElapsedMs,
                });

                throwIfCancelled();

                const tempFilePath = await this.createTranscriptionTempFile(
                  filePath,
                  rawTranscript
                );
                progressBus.publish({
                  stage: "temp-file-created",
                  path: tempFilePath,
                });
              } else {
                // 30 minutes or longer: chunk the WAV

                const chunks = computeTimeBasedChunkRanges({
                  totalMs,
                  chunkDurationMs: CHUNK_DURATION_MS,
                  overlapMs: 1500,
                });

                const FAILED_PLACEHOLDER_PREFIX = "{{CHUNK_FAILED:";
                const FAILED_PLACEHOLDER_SUFFIX = "}}";
                const chunkResults: string[] = new Array(chunks.length).fill(
                  ""
                );
                const chunkUploadedFiles: (UploadedFileInfo | null)[] =
                  new Array(chunks.length).fill(null);
                const failedChunkIndices: number[] = [];

                for (let ci = 0; ci < chunks.length; ci++) {
                  throwIfCancelled();

                  const chunkIndex = ci + 1;
                  const c = chunks[ci];
                  progressBus.publish({
                    stage: "chunk-start",
                    chunkIndex: chunkIndex,
                    chunkTotal: chunks.length,
                  });

                  const chunkBuffer = this.audioService.sliceWavPcm16(
                    wavBuffer,
                    c.startMs,
                    c.endMs
                  );

                  try {
                    const chunkBase64 =
                      await this.audioService.arrayBufferToBase64Async(
                        chunkBuffer
                      );
                    const result = await this.transcriptionService.transcribe(
                      apiKey!,
                      DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
                      chunkBase64,
                      "audio/wav",
                      model,
                      6 * 60 * 1000,
                      () => {
                        progressBus.publish({
                          stage: "file-upload-start",
                        });
                      },
                      (uploadElapsedMs, uploadedFile) => {
                        chunkUploadedFiles[ci] = uploadedFile;
                        progressBus.publish({
                          stage: "file-upload-complete",
                          elapsedMs: uploadElapsedMs,
                        });
                        if (this.isDevMode) {
                          console.debug(
                            `[DEBUG] Chunk ${chunkIndex} file uploaded:`,
                            {
                              uri: uploadedFile.uri,
                              mimeType: uploadedFile.mimeType,
                              expirationTime: uploadedFile.expirationTime,
                            }
                          );
                        }
                      },
                      () => {
                        progressBus.publish({
                          stage: "api-request-start",
                        });
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

                    if (this.isDevMode) {
                      console.debug(
                        `[DEBUG] Chunk ${chunkIndex} response length: ${
                          result.text.length
                        }, content: ${JSON.stringify(
                          result.text.substring(0, 100)
                        )}`
                      );
                    }

                    publishUsage(result);

                    throwIfCancelled();

                    const trimmedText = result.text.trim();

                    if (trimmedText.length < 50) {
                      progressBus.publish({
                        stage: "chunk-short-response",
                        chunkIndex: chunkIndex,
                        chunkTotal: chunks.length,
                        charCount: trimmedText.length,
                      });
                    }

                    chunkResults[ci] = trimmedText;

                    progressBus.publish({
                      stage: "chunk-complete",
                      chunkIndex: chunkIndex,
                      chunkTotal: chunks.length,
                    });
                  } catch (e) {
                    if (isTranscriptionCancelledError(e)) {
                      throw e;
                    }

                    failedChunkIndices.push(ci);
                    chunkResults[
                      ci
                    ] = `${FAILED_PLACEHOLDER_PREFIX}${chunkIndex}${FAILED_PLACEHOLDER_SUFFIX}`;

                    progressBus.publish({
                      stage: "chunk-failed",
                      chunkIndex: chunkIndex,
                      chunkTotal: chunks.length,
                      message: e?.message || String(e),
                    });
                  }
                }

                // Build transcript and save temp file
                rawTranscript = chunkResults
                  .filter((t) => t.length > 0)
                  .join("\n\n");

                const transcriptionStepElapsedMs = Math.round(
                  performance.now() - transcriptionStepStart
                );
                progressBus.publish({
                  stage: "transcription-step-complete",
                  elapsedMs: transcriptionStepElapsedMs,
                });

                throwIfCancelled();

                const tempFilePath = await this.createTranscriptionTempFile(
                  filePath,
                  rawTranscript
                );
                progressBus.publish({
                  stage: "temp-file-created",
                  path: tempFilePath,
                });

                // Wait for retries on failed chunks
                if (failedChunkIndices.length > 0) {
                  await this.handleChunkRetries(
                    failedChunkIndices,
                    chunks,
                    chunkResults,
                    chunkUploadedFiles,
                    wavBuffer,
                    apiKey!,
                    model,
                    tempFilePath,
                    FAILED_PLACEHOLDER_PREFIX,
                    FAILED_PLACEHOLDER_SUFFIX
                  );

                  // Rebuild transcript after retries
                  rawTranscript = chunkResults
                    .filter((t) => t.length > 0)
                    .join("\n\n");
                }
              }
            }

            throwIfCancelled();

            // Step 2: Classify transcript into a category (or use General)
            let detectedCategory: string = "";
            let categoryPrompt: string = "";

            const hasEnabledCategories = categories.some((c) => c.enabled);

            if (!enableCategoryClassification) {
              // No classification — use General category prompt
              const generalCat = categories.find(
                (c) => c.id === GENERAL_CATEGORY_ID
              );
              detectedCategory = generalCat?.name || "General";
              categoryPrompt = generalCat?.prompt || templateModePrompt;
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
                rawTranscript,
                categories,
                model,
                filePath,
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
                  : templateModePrompt;
              } else {
                categoryPrompt = templateModePrompt;
              }
            }

            // Step 3: Summarization using category prompt
            transcript = await this.runSummarizationWithRetry(
              apiKey!,
              categoryPrompt,
              rawTranscript,
              model,
              abortController.signal,
              publishUsage
            );

            throwIfCancelled();
          } else {
            const audioBase64 =
              await this.audioService.arrayBufferToBase64Async(audioBuffer);
            const result = await this.transcriptionService.transcribe(
              apiKey!,
              templateModePrompt,
              audioBase64,
              mimeType,
              model,
              6 * 60 * 1000,
              () => {
                progressBus.publish({ stage: "file-upload-start" });
              },
              (uploadElapsedMs, uploadedFile) => {
                progressBus.publish({
                  stage: "file-upload-complete",
                  elapsedMs: uploadElapsedMs,
                });
                if (this.isDevMode) {
                  console.debug(`[DEBUG] File uploaded:`, {
                    uri: uploadedFile.uri,
                    mimeType: uploadedFile.mimeType,
                    expirationTime: uploadedFile.expirationTime,
                  });
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
              abortController.signal
            );

            publishUsage(result);
            transcript = result.text;

            throwIfCancelled();
          }

          throwIfCancelled();

          await this.obsidianInteractor.appendTextToFile(
            activeFile.path,
            currentCursorPosition.line,
            currentCursorPosition.ch,
            transcript
          );

          progressBus.publish({ stage: "success" });
        } catch (e) {
          if (isTranscriptionCancelledError(e)) {
            new Notice("Transcription cancelled");
            progressBus.publish({ stage: "cancelled" });
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
    filePath: string,
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
        await this.updateTempFileCategory(filePath, detectedCategory);
      } else {
        const generalCategory = categories.find(
          (c) => c.id === GENERAL_CATEGORY_ID
        );
        detectedCategory = generalCategory
          ? generalCategory.name
          : categories[categories.length - 1].name;
        await this.updateTempFileCategory(
          filePath,
          `${detectedCategory} (AI suggested: ${aiCategory})`
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

      progressBus.publish({
        stage: "classification-step-failed",
        message: e instanceof Error ? e.message : String(e),
      });

      // Wait for retry
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
      const unsubscribe = progressBus.subscribe(async (event) => {
        if (event.stage === "cancel-requested") {
          unsubscribe();
          reject(new TranscriptionCancelledError());
          return;
        }

        if (event.stage !== eventStage) return;

        unsubscribe();

        try {
          const result = await retryFn();
          resolve(result);
        } catch (retryError) {
          if (isTranscriptionCancelledError(retryError)) {
            reject(retryError);
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

          try {
            const nextResult = await this.waitForRetryEvent(
              eventStage,
              retryFn
            );
            resolve(nextResult);
          } catch (nextError) {
            reject(nextError);
          }
        }
      });
    });
  }

  private isUploadedFileValid(file: UploadedFileInfo | null): boolean {
    if (!file?.uri || !file?.mimeType) return false;
    if (!file.expirationTime) return false;
    const expiration = new Date(file.expirationTime).getTime();
    // Consider invalid if less than 1 minute remaining
    return expiration > Date.now() + 60 * 1000;
  }

  private async handleChunkRetries(
    failedIndices: number[],
    chunks: { startMs: number; endMs: number }[],
    chunkResults: string[],
    chunkUploadedFiles: (UploadedFileInfo | null)[],
    wavBuffer: ArrayBuffer,
    apiKey: string,
    model: string,
    tempFilePath: string,
    placeholderPrefix: string,
    placeholderSuffix: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const remaining = new Set(failedIndices);
      let unsubscribe: (() => void) | null = null;

      const finish = () => {
        if (unsubscribe) unsubscribe();
        resolve();
      };

      unsubscribe = progressBus.subscribe(async (event) => {
        if (event.stage === "cancel-requested") {
          if (unsubscribe) unsubscribe();
          reject(new TranscriptionCancelledError());
          return;
        }

        if (event.stage !== "chunk-retry-requested") return;

        const ci = event.chunkIndex - 1;
        if (!remaining.has(ci)) return;

        const chunkIndex = event.chunkIndex;
        const c = chunks[ci];

        progressBus.publish({
          stage: "chunk-start",
          chunkIndex: chunkIndex,
          chunkTotal: chunks.length,
        });

        try {
          // Check if cached upload is still valid
          const cachedFile = this.isUploadedFileValid(chunkUploadedFiles[ci])
            ? chunkUploadedFiles[ci]!
            : undefined;

          if (this.isDevMode) {
            console.debug(
              `[DEBUG] Chunk ${chunkIndex} retry — cached file:`,
              cachedFile
                ? {
                    uri: cachedFile.uri,
                    expirationTime: cachedFile.expirationTime,
                    reusing: true,
                  }
                : { reusing: false, reason: "expired or missing" }
            );
          }

          const chunkBuffer = this.audioService.sliceWavPcm16(
            wavBuffer,
            c.startMs,
            c.endMs
          );
          const chunkBase64 = await this.audioService.arrayBufferToBase64Async(
            chunkBuffer
          );
          const result = await this.transcriptionService.transcribe(
            apiKey,
            DEFAULT_TRANSCRIPTION_ONLY_PROMPT,
            chunkBase64,
            "audio/wav",
            model,
            6 * 60 * 1000,
            () => {
              progressBus.publish({ stage: "file-upload-start" });
            },
            (uploadElapsedMs) => {
              progressBus.publish({
                stage: "file-upload-complete",
                elapsedMs: uploadElapsedMs,
              });
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
            undefined,
            true,
            cachedFile
          );

          // Store new upload info for potential future retries
          if (result.uploadedFile) {
            chunkUploadedFiles[ci] = result.uploadedFile;
          }

          const trimmedText = result.text.trim();
          chunkResults[ci] = trimmedText;

          // Replace placeholder in temp file
          const placeholder = `${placeholderPrefix}${chunkIndex}${placeholderSuffix}`;
          const file = this.app.vault.getAbstractFileByPath(tempFilePath);
          if (file instanceof TFile) {
            await this.app.vault.process(file, (data) => {
              return data.replace(placeholder, trimmedText);
            });
          }

          remaining.delete(ci);

          progressBus.publish({
            stage: "chunk-retry-complete",
            chunkIndex: chunkIndex,
            chunkTotal: chunks.length,
            success: true,
          });
        } catch (e) {
          progressBus.publish({
            stage: "chunk-retry-complete",
            chunkIndex: chunkIndex,
            chunkTotal: chunks.length,
            success: false,
          });
        }

        if (remaining.size === 0) {
          finish();
        }
      });
    });
  }

  private async openProgressView(): Promise<void> {
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
          dir === audioDir && name.startsWith(prefix) && name.endsWith(".md")
        );
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (candidates.length === 0) return null;

    const file = candidates[0];
    const content = await this.app.vault.read(file);

    // Extract category from frontmatter
    let category: string | undefined;
    const categoryMatch = content.match(
      /^---[\s\S]*?category:\s*(.+)[\s\S]*?---/
    );
    if (categoryMatch) {
      category = categoryMatch[1].trim();
    }

    // Extract transcription text after "## Transcription\n\n"
    const marker = "## Transcription\n\n";
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) return null;

    const text = content.substring(markerIndex + marker.length).trim();
    if (text.length === 0) return null;

    return { path: file.path, text, category };
  }

  private async updateTempFileCategory(
    audioFilePath: string,
    category: string
  ): Promise<void> {
    const existing = await this.findExistingTranscription(audioFilePath);
    if (!existing) return;

    const file = this.app.vault.getAbstractFileByPath(existing.path);
    if (!file || !(file instanceof TFile)) return;

    await this.app.vault.process(file, (data) => {
      // Check if category already exists in frontmatter
      if (data.match(/^---[\s\S]*?category:\s*.+[\s\S]*?---/)) {
        return data.replace(/(category:\s*).+/, `$1${category}`);
      }
      // Add category to frontmatter
      return data.replace(/^(---\n)/, `$1category: ${category}\n`);
    });
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
    const tempFileName = `_transcription_${audioName}_${timestamp}.md`;

    const audioDir = audioFilePath.includes("/")
      ? audioFilePath.substring(0, audioFilePath.lastIndexOf("/"))
      : "";
    const tempFilePath = audioDir
      ? `${audioDir}/${tempFileName}`
      : tempFileName;

    const content =
      `---\naudio: ${audioFilePath}\ncreated: ${new Date().toISOString()}\n---\n\n` +
      `## Transcription\n\n${transcription}\n`;

    await this.app.vault.create(tempFilePath, content);
    return tempFilePath;
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
