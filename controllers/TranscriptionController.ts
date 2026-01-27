import { App, Editor, Notice, TFile } from "obsidian";
import { ObsidianInteractorService } from "../_base/services/obsidian/ObsidianInteractorService";
import { TranscriptionService } from "../_base/services/transcription/TranscriptionService";
import { computeWavChunkRanges } from "../_base/services/transcription/chunking";
import { progressBus } from "../_base/utils/progressBus";
import { ObsidianFileService } from "_base/services/obsidian/obisdianFileService";
import { VIEW_TYPE_PROGRESS } from "_base/constants/progress";
import { AudioService } from "../_base/services/audio/AudioService";
import { AUDIO_FILE_REGEX } from "_base/constants/regex";
import { ContextNotesService } from "../_base/services/context/ContextNotesService";
import { PromptBuilderService } from "../_base/services/prompt/PromptBuilderService";

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
  private contextNotesService: ContextNotesService = new ContextNotesService();
  private promptBuilderService: PromptBuilderService =
    new PromptBuilderService();

  constructor(private app: App) {}

  async run(
    editor: Editor,
    apiKey: string | undefined,
    prompt: string,
    model: string,
    includeContextualNotes: boolean = false,
    contextNotesMaxLength: number = 5000
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

    // Extract contextual notes if enabled
    let enhancedPrompt = prompt;
    if (includeContextualNotes) {
      const fullText = editor.getValue();
      const contextResult = this.contextNotesService.extractContextNotes(
        fullText,
        filePath,
        contextNotesMaxLength
      );

      if (contextResult) {
        enhancedPrompt = this.promptBuilderService.buildPrompt(
          prompt,
          contextResult.notes
        );
        progressBus.publish({
          stage: "context-notes-extracted",
          length: contextResult.notes.length,
          truncated: contextResult.wasTruncated,
        });
        console.debug(
          "[TranscriptionController] Context notes extracted:",
          contextResult.notes.length,
          "chars, truncated:",
          contextResult.wasTruncated
        );
      }
    }

    await this.openProgressView();

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

    try {
      progressBus.publish({ stage: "file-detected", fileName: filePath });
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file == null || !(file instanceof TFile))
        throw new Error(filePath + " does not exist");

      try {
        const audioBuffer = await this.app.vault.readBinary(file);

        this.writing = true;

        const mimeType = this.fileTypeToMimeType(fileType);

        progressBus.publish({
          stage: "file-size",
          sizeBytes: audioBuffer.byteLength,
        });

        try {
          let transcript: string;
          if (this.isPcm16Wav(audioBuffer)) {
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
            const chunkPrompt =
              "Transcribe the following audio. Output only the transcript text for this part, without any extra commentary.";
            let combined = "";
            let index = 0;
            for (const c of chunks) {
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
                const text = await this.transcriptionService.transcribe(
                  apiKey!,
                  chunkPrompt,
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
                  }
                );
                combined += preface + text.trim();
                progressBus.publish({
                  stage: "chunk-complete",
                  chunkIndex: index,
                  chunkTotal: chunks.length,
                });
              } catch (e) {
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
          } else {
            const audioBase64 =
              await this.audioService.arrayBufferToBase64Async(audioBuffer);
            transcript = await this.transcriptionService.transcribe(
              apiKey!,
              enhancedPrompt,
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
              }
            );
          }

          await this.obsidianInteractor.appendTextToFile(
            activeFile.path,
            currentCursorPosition.line,
            currentCursorPosition.ch,
            transcript
          );

          progressBus.publish({ stage: "success" });
        } catch (e) {
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
        console.error("[readBinary] error", error);
        new Notice("Transcription failed");
        progressBus.publish({ stage: "error", message: error.message });
      }
    } catch (error) {
      console.warn(error.message);
      new Notice("Transcription failed");
      progressBus.publish({ stage: "error", message: error.message });
    }
  }

  private async openProgressView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROGRESS);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const rightSplit = this.app.workspace.getRightLeaf(false);
    if (rightSplit) {
      await rightSplit.setViewState({
        type: VIEW_TYPE_PROGRESS,
        active: true,
      });
      this.app.workspace.revealLeaf(rightSplit);
    } else {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIEW_TYPE_PROGRESS,
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
