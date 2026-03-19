import { App, Editor, Notice, TFile } from "obsidian";
import { ObsidianInteractorService } from "../_base/services/obsidian/ObsidianInteractorService";
import {
  TranscriptionResult,
  TranscriptionCancelledError,
  TranscriptionService,
  isTranscriptionCancelledError,
} from "../_base/services/transcription/TranscriptionService";
import {
  computeWavChunkRanges,
  computeTimeBasedChunkRanges,
} from "../_base/services/transcription/chunking";
import { progressBus } from "../_base/utils/progressBus";
import { ObsidianFileService } from "_base/services/obsidian/obisdianFileService";
import { AudioService } from "../_base/services/audio/AudioService";
import { AUDIO_FILE_REGEX } from "_base/constants/regex";
import { DEFAULT_TRANSCRIPTION_ONLY_PROMPT } from "_base/constants/setting";

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

  constructor(private app: App, private progressViewType: string) {}

  async run(
    editor: Editor,
    apiKey: string | undefined,
    prompt: string,
    model: string,
    outputTemplate: string,
    enableTranscribeThenSummarize: boolean = false
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
                  abortController.signal
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
            // Step 1: Transcription with chunking
            const transcriptionStepStart = performance.now();
            progressBus.publish({ stage: "transcription-step-start" });

            const CHUNK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
            const CHUNK_DURATION_MS = 20 * 60 * 1000; // 20 minutes

            // Determine audio duration without full WAV conversion
            let totalMs: number;
            if (this.isPcm16Wav(audioBuffer)) {
              const header = this.audioService.parseWavHeader(audioBuffer);
              const bytesPerFrame =
                header.numChannels * (header.bitsPerSample / 8);
              const totalFrames = Math.floor(header.dataSize / bytesPerFrame);
              totalMs = Math.floor(
                (totalFrames / header.sampleRate) * 1000
              );
            } else {
              totalMs =
                await this.audioService.getAudioDurationMs(audioBuffer);
            }

            let rawTranscript: string;
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
                  abortController.signal
                );

              publishUsage(transcriptionResult);
              rawTranscript = transcriptionResult.text;
            } else {
              // 30 minutes or longer: decode to WAV PCM16 and chunk
              progressBus.publish({ stage: "preparing-audio" });
              let wavBuffer: ArrayBuffer;
              if (this.isPcm16Wav(audioBuffer)) {
                wavBuffer = audioBuffer;
              } else {
                wavBuffer =
                  await this.audioService.decodeToWavPcm16(audioBuffer);
              }

              const chunks = computeTimeBasedChunkRanges({
                totalMs,
                chunkDurationMs: CHUNK_DURATION_MS,
                overlapMs: 1500,
              });

              let combined = "";
              let chunkIndex = 0;
              for (const c of chunks) {
                throwIfCancelled();

                chunkIndex++;
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
                    abortController.signal
                  );

                  publishUsage(result);

                  throwIfCancelled();

                  if (combined.length > 0) {
                    combined += "\n\n";
                  }
                  combined += result.text.trim();

                  progressBus.publish({
                    stage: "chunk-complete",
                    chunkIndex: chunkIndex,
                    chunkTotal: chunks.length,
                  });
                } catch (e) {
                  if (isTranscriptionCancelledError(e)) {
                    throw e;
                  }

                  progressBus.publish({
                    stage: "chunk-failed",
                    chunkIndex: chunkIndex,
                    chunkTotal: chunks.length,
                    message: e?.message || String(e),
                  });
                  combined +=
                    `\n\n[[Chunk ${chunkIndex} failed: ${
                      e?.message || String(e)
                    }]]`;
                }
              }
              rawTranscript = combined.trim();
            }

            const transcriptionStepElapsedMs = Math.round(
              performance.now() - transcriptionStepStart
            );
            progressBus.publish({
              stage: "transcription-step-complete",
              elapsedMs: transcriptionStepElapsedMs,
            });

            throwIfCancelled();

            // Create temp file with transcription
            const tempFilePath = await this.createTranscriptionTempFile(
              filePath,
              rawTranscript
            );
            progressBus.publish({
              stage: "temp-file-created",
              path: tempFilePath,
            });

            throwIfCancelled();

            // Step 2: Summarization using transcribed text
            const summarizationStepStart = performance.now();
            progressBus.publish({ stage: "summarization-step-start" });

            const summaryResult =
              await this.transcriptionService.summarizeText(
                apiKey!,
                templateModePrompt,
                rawTranscript,
                model,
                6 * 60 * 1000,
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

            publishUsage(summaryResult);
            transcript = summaryResult.text;

            const summarizationStepElapsedMs = Math.round(
              performance.now() - summarizationStepStart
            );
            progressBus.publish({
              stage: "summarization-step-complete",
              elapsedMs: summarizationStepElapsedMs,
            });

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

  private async createTranscriptionTempFile(
    audioFilePath: string,
    transcription: string
  ): Promise<string> {
    const audioName = audioFilePath
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
