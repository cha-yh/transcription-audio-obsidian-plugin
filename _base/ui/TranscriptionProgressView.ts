import { ItemView, WorkspaceLeaf } from "obsidian";
import { progressBus } from "../utils/progressBus";
import {
  VIEW_ICON,
  VIEW_TITLE,
  VIEW_TYPE_PROGRESS,
} from "../constants/progress";
import type { ProgressEvent } from "../types/progress";
import { formatBytes, formatDuration } from "../utils/format";

export class TranscriptionProgressView extends ItemView {
  private unsubscribe?: () => void;
  private headerEl!: HTMLElement;
  private fileNameEl!: HTMLElement;
  private fileSizeEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private targetFileEl!: HTMLElement;
  private chunkWrapEl!: HTMLElement;
  private chunkBarEl!: HTMLProgressElement;
  private chunkLabelEl!: HTMLElement;
  private logEl!: HTMLElement;
  private startedAtMs: number = 0;
  private chunkTotal: number = 0;
  private chunkIndex: number = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PROGRESS;
  }
  getDisplayText(): string {
    return VIEW_TITLE;
  }
  getIcon(): string {
    return VIEW_ICON;
  }

  async onOpen(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    this.headerEl = containerEl.createEl("div", {
      cls: "transcription-audio-header",
    });
    this.headerEl.createEl("h3", { text: VIEW_TITLE });

    const infoEl = containerEl.createEl("div", {
      cls: "transcription-audio-info",
    });
    const row1 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row1.createEl("span", { text: "File: ", cls: "transcription-audio-label" });
    this.fileNameEl = row1.createEl("span", { text: "-" });

    const row2 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row2.createEl("span", { text: "Size: ", cls: "transcription-audio-label" });
    this.fileSizeEl = row2.createEl("span", { text: "-" });

    const row3 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row3.createEl("span", {
      text: "Status: ",
      cls: "transcription-audio-label",
    });
    this.statusEl = row3.createEl("span", { text: "Idle" });

    const row4 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row4.createEl("span", {
      text: "Target: ",
      cls: "transcription-audio-label",
    });
    this.targetFileEl = row4.createEl("span", { text: "-" });

    this.chunkWrapEl = containerEl.createEl("div", {
      cls: "transcription-audio-chunks",
    });
    this.chunkLabelEl = this.chunkWrapEl.createEl("div", { text: "Chunk: -" });
    this.chunkBarEl = this.chunkWrapEl.createEl("progress");
    this.chunkBarEl.max = 1;
    this.chunkBarEl.value = 0;

    this.logEl = containerEl.createEl("div", {
      cls: "transcription-audio-log",
    });
    this.logEl.createEl("div", { text: "Log start" });

    this.unsubscribe = progressBus.subscribe((e) => this.onProgress(e));
  }

  async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
  }

  private pushLog(text: string): void {
    const line = this.logEl.createEl("div", { text });
    line.scrollIntoView({ block: "end" });
  }

  private onProgress(e: ProgressEvent): void {
    switch (e.stage) {
      case "file-detected": {
        const name = e.fileName.split("/").pop() || e.fileName;
        this.fileNameEl.setText(name);
        this.statusEl.setText("File detected");
        this.pushLog(`File detected: ${name}`);
        this.startedAtMs = Date.now();
        break;
      }
      case "file-size": {
        this.fileSizeEl.setText(formatBytes(e.sizeBytes));
        this.pushLog(`Size: ${formatBytes(e.sizeBytes)}`);
        break;
      }
      case "preparing-audio": {
        this.statusEl.setText("Preparing audio");
        this.pushLog("Preparing audio");
        break;
      }
      case "target-file-selected": {
        const name = e.path.split("/").pop() || e.path;
        this.targetFileEl.setText(`${name} (${e.line}:${e.ch})`);
        this.pushLog(`Target selected: ${e.path} @ ${e.line}:${e.ch}`);
        break;
      }
      case "chunk-start": {
        this.chunkTotal = e.chunkTotal;
        this.chunkIndex = e.chunkIndex;
        this.chunkBarEl.max = this.chunkTotal;
        this.chunkBarEl.value = Math.max(
          this.chunkBarEl.value,
          this.chunkIndex - 1
        );
        this.chunkLabelEl.setText(
          `Chunk ${e.chunkIndex}/${e.chunkTotal} running`
        );
        this.statusEl.setText("Transcribing chunk");
        this.pushLog(`Chunk start: ${e.chunkIndex}/${e.chunkTotal}`);
        break;
      }
      case "chunk-complete": {
        this.chunkBarEl.max = e.chunkTotal;
        this.chunkBarEl.value = e.chunkIndex;
        this.chunkLabelEl.setText(`Chunk ${e.chunkIndex}/${e.chunkTotal} done`);
        this.pushLog(`Chunk complete: ${e.chunkIndex}/${e.chunkTotal}`);
        break;
      }
      case "chunk-failed": {
        this.pushLog(
          `Chunk failed: ${e.chunkIndex}/${e.chunkTotal} - ${e.message}`
        );
        break;
      }
      case "api-request-start": {
        this.statusEl.setText("Requesting API");
        this.pushLog("API request start");
        break;
      }
      case "api-request-retry": {
        this.statusEl.setText("Retrying API");
        this.pushLog(
          `API retry: attempt ${e.attempt}${e.message ? " - " + e.message : ""}`
        );
        break;
      }
      case "api-request-complete": {
        this.statusEl.setText("API done");
        this.pushLog(`API done: ${formatDuration(e.elapsedMs)}`);
        break;
      }
      case "success": {
        const elapsed = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
        this.statusEl.setText("Success");
        this.pushLog(`Success: total ${formatDuration(elapsed)}`);
        break;
      }
      case "error": {
        this.statusEl.setText("Failed");
        this.pushLog(`Failed: ${e.message}`);
        break;
      }
    }
  }
}
