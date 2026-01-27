import { ItemView, WorkspaceLeaf } from "obsidian";
import { progressBus } from "../utils/progressBus";
import {
  VIEW_ICON,
  VIEW_TITLE,
  VIEW_TYPE_PROGRESS,
} from "../constants/progress";
import type { ProgressEvent } from "../types/progress";
import { formatBytes, formatDuration } from "../utils/format";

interface TranscriptionSession {
  sessionEl: HTMLElement;
  fileNameEl: HTMLElement;
  fileSizeEl: HTMLElement;
  statusEl: HTMLElement;
  targetFileEl: HTMLElement;
  modelEl: HTMLElement;
  chunkWrapEl?: HTMLElement;
  chunkBarEl?: HTMLProgressElement;
  chunkLabelEl?: HTMLElement;
  logEl: HTMLElement;
  latestLogEl: HTMLElement;
  detailButtonEl: HTMLElement;
  logHistoryEl: HTMLElement;
  indicatorEl: HTMLElement;
  logHistory: string[];
  isLogExpanded: boolean;
  startedAtMs: number;
  chunkTotal: number;
  chunkIndex: number;
}

export class TranscriptionProgressView extends ItemView {
  private wrapperEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private sessionsContainerEl!: HTMLElement;
  private currentSession?: TranscriptionSession;
  private pendingEvents: ProgressEvent[] = [];

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

    // Add top-level wrapper div
    this.wrapperEl = containerEl.createEl("div", {
      cls: "transcription-audio-wrapper",
    });
    this.wrapperEl.style.paddingLeft = "12px";
    this.wrapperEl.style.paddingRight = "12px";
    this.wrapperEl.style.paddingBottom = "40px";
    this.wrapperEl.style.height = "100%";
    this.wrapperEl.style.overflowY = "auto";

    this.headerEl = this.wrapperEl.createEl("div", {
      cls: "transcription-audio-header",
    });
    this.headerEl.createEl("h3", { text: VIEW_TITLE });

    // Container for all sessions
    this.sessionsContainerEl = this.wrapperEl.createEl("div", {
      cls: "transcription-audio-sessions",
    });

    this.registerEvent(progressBus.subscribe((e) => this.onProgress(e)));
  }

  private pushLog(
    summaryText: string,
    detailText: string,
    session: TranscriptionSession
  ): void {
    // Add to log history (always store full detail text)
    session.logHistory.push(detailText);

    // Update status bar with summary (short message for quick glance)
    session.latestLogEl.setText(summaryText);

    // Add to log detail area if expanded
    if (session.isLogExpanded) {
      const line = session.logHistoryEl.createEl("div", { text: detailText });
      line.scrollIntoView({ block: "end" });
    }
  }

  private createNewSession(): TranscriptionSession {
    // Create new session container (always add to the top)
    const newSessionEl = document.createElement("div");
    newSessionEl.className = "transcription-audio-session";

    // Insert before existing session if exists, otherwise append
    if (this.currentSession) {
      this.sessionsContainerEl.insertBefore(
        newSessionEl,
        this.currentSession.sessionEl
      );
    } else {
      this.sessionsContainerEl.appendChild(newSessionEl);
    }

    // Create info area
    const infoEl = newSessionEl.createEl("div", {
      cls: "transcription-audio-info",
    });
    const row1 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row1.createEl("span", { text: "File: ", cls: "transcription-audio-label" });
    const fileNameEl = row1.createEl("span", { text: "-" });

    const row2 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row2.createEl("span", { text: "Size: ", cls: "transcription-audio-label" });
    const fileSizeEl = row2.createEl("span", { text: "-" });

    const row3 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row3.createEl("span", {
      text: "Status: ",
      cls: "transcription-audio-label",
    });
    const statusEl = row3.createEl("span", { text: "Idle" });

    const row4 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row4.createEl("span", {
      text: "Target: ",
      cls: "transcription-audio-label",
    });
    const targetFileEl = row4.createEl("span", { text: "-" });

    const row5 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row5.createEl("span", {
      text: "Model: ",
      cls: "transcription-audio-label",
    });
    const modelEl = row5.createEl("span", { text: "-" });

    // Create log area
    const logEl = newSessionEl.createEl("div", {
      cls: "transcription-audio-log",
    });

    // Status bar: indicator + summary message + detail toggle button
    const statusBarEl = logEl.createEl("div", {
      cls: "transcription-audio-latest-log",
    });

    // Status indicator (spinner by default)
    const indicatorEl = statusBarEl.createEl("div", {
      cls: "transcription-audio-indicator",
    });
    indicatorEl.innerHTML = `<svg class="transcription-audio-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

    // Summary message (short, shown in status bar)
    const latestLogEl = statusBarEl.createEl("span", {
      text: "Log start",
      cls: "transcription-audio-latest-log-text",
    });

    // Detail toggle button
    const detailButtonEl = statusBarEl.createEl("button", {
      text: "detail",
      cls: "transcription-audio-detail-button",
    });

    // Log detail area (hidden by default, shows full log history)
    const logHistoryEl = logEl.createEl("div", {
      cls: "transcription-audio-log-history",
    });
    logHistoryEl.style.display = "none";

    // Create session object
    const session: TranscriptionSession = {
      sessionEl: newSessionEl,
      fileNameEl,
      fileSizeEl,
      statusEl,
      targetFileEl,
      modelEl,
      logEl,
      latestLogEl,
      detailButtonEl,
      logHistoryEl,
      indicatorEl,
      logHistory: ["Log start"],
      isLogExpanded: false,
      startedAtMs: 0,
      chunkTotal: 0,
      chunkIndex: 0,
    };

    // Detail button click event - toggle only this session's log
    detailButtonEl.addEventListener("click", () => {
      this.toggleLogHistory(session);
    });

    this.currentSession = session;
    return session;
  }

  private toggleLogHistory(session: TranscriptionSession): void {
    session.isLogExpanded = !session.isLogExpanded;

    if (session.isLogExpanded) {
      // Expand: show all history logs
      session.logHistoryEl.style.display = "block";
      session.logHistoryEl.empty();
      session.logHistory.forEach((log) => {
        session.logHistoryEl.createEl("div", { text: log });
      });
      session.detailButtonEl.setText("close");
    } else {
      // Collapse: hide history
      session.logHistoryEl.style.display = "none";
      session.detailButtonEl.setText("detail");
    }
  }

  private updateIndicator(
    session: TranscriptionSession,
    status: "success" | "loading" | "error"
  ): void {
    if (status === "success") {
      // Show check icon
      session.indicatorEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      session.indicatorEl.className =
        "transcription-audio-indicator transcription-audio-indicator-success";
    } else if (status === "error") {
      // Show error icon (circle with horizontal line - blocked/prohibited)
      session.indicatorEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`;
      session.indicatorEl.className =
        "transcription-audio-indicator transcription-audio-indicator-error";
    } else {
      // Show spinner
      session.indicatorEl.innerHTML = `<svg class="transcription-audio-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
      session.indicatorEl.className = "transcription-audio-indicator";
    }
  }

  private processEvent(e: ProgressEvent, session: TranscriptionSession): void {
    switch (e.stage) {
      case "model-selected": {
        session.modelEl.setText(e.model);
        this.pushLog(`Model: ${e.model}`, `Model: ${e.model}`, session);
        break;
      }
      case "target-file-selected": {
        const name = e.path.split("/").pop() || e.path;
        session.targetFileEl.setText(`${name} (${e.line}:${e.ch})`);
        this.pushLog(
          `Target selected: ${name}`,
          `Target selected: ${e.path} @ ${e.line}:${e.ch}`,
          session
        );
        break;
      }
    }
  }

  private onProgress(e: ProgressEvent): void {
    switch (e.stage) {
      case "file-detected": {
        // Start new transcription session - add new session container to the top
        const newSession = this.createNewSession();
        const name = e.fileName.split("/").pop() || e.fileName;
        newSession.fileNameEl.setText(name);
        newSession.statusEl.setText("File detected");
        this.pushLog(
          `File detected: ${name}`,
          `File detected: ${name}`,
          newSession
        );
        newSession.startedAtMs = Date.now();

        // Process buffered events (model-selected, target-file-selected, etc.)
        for (const pendingEvent of this.pendingEvents) {
          this.processEvent(pendingEvent, newSession);
        }
        this.pendingEvents = [];
        break;
      }
      case "model-selected": {
        // Always buffer events that come before file-detected
        // (file-detected creates a new session for each new transcription)
        this.pendingEvents.push(e);
        break;
      }
      case "target-file-selected": {
        // Always buffer events that come before file-detected
        // (file-detected creates a new session for each new transcription)
        this.pendingEvents.push(e);
        break;
      }
      case "file-size": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.fileSizeEl.setText(formatBytes(e.sizeBytes));
        const sizeText = formatBytes(e.sizeBytes);
        this.pushLog(
          `Size: ${sizeText}`,
          `Size: ${sizeText}`,
          this.currentSession
        );
        break;
      }
      case "preparing-audio": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Preparing audio");
        this.pushLog("Preparing audio", "Preparing audio", this.currentSession);
        break;
      }
      case "context-notes-extracted": {
        if (!this.currentSession) {
          break;
        }
        const truncatedText = e.truncated ? " (truncated)" : "";
        this.pushLog(
          `Context notes: ${e.length} chars${truncatedText}`,
          `Context notes extracted: ${e.length} characters${truncatedText}`,
          this.currentSession
        );
        break;
      }
      case "chunk-start": {
        if (!this.currentSession) {
          break;
        }
        // Create chunk UI only when chunk-start event is published
        if (!this.currentSession.chunkWrapEl) {
          this.currentSession.chunkWrapEl =
            this.currentSession.sessionEl.createEl("div", {
              cls: "transcription-audio-chunks",
            });
          this.currentSession.chunkLabelEl =
            this.currentSession.chunkWrapEl.createEl("div", {
              text: "Chunk: -",
            });
          this.currentSession.chunkBarEl =
            this.currentSession.chunkWrapEl.createEl("progress");
          this.currentSession.chunkBarEl.max = 1;
          this.currentSession.chunkBarEl.value = 0;
        }
        this.currentSession.chunkTotal = e.chunkTotal;
        this.currentSession.chunkIndex = e.chunkIndex;
        if (
          this.currentSession.chunkBarEl &&
          this.currentSession.chunkLabelEl
        ) {
          this.currentSession.chunkBarEl.max = this.currentSession.chunkTotal;
          this.currentSession.chunkBarEl.value = Math.max(
            this.currentSession.chunkBarEl.value,
            this.currentSession.chunkIndex - 1
          );
          this.currentSession.chunkLabelEl.setText(
            `Chunk ${e.chunkIndex}/${e.chunkTotal} running`
          );
        }
        this.currentSession.statusEl.setText("Transcribing chunk");
        this.pushLog(
          `Chunk ${e.chunkIndex}/${e.chunkTotal} running`,
          `Chunk start: ${e.chunkIndex}/${e.chunkTotal}`,
          this.currentSession
        );
        break;
      }
      case "chunk-complete": {
        if (!this.currentSession) {
          break;
        }
        if (
          this.currentSession.chunkBarEl &&
          this.currentSession.chunkLabelEl
        ) {
          this.currentSession.chunkBarEl.max = e.chunkTotal;
          this.currentSession.chunkBarEl.value = e.chunkIndex;
          this.currentSession.chunkLabelEl.setText(
            `Chunk ${e.chunkIndex}/${e.chunkTotal} done`
          );
        }
        this.pushLog(
          `Chunk ${e.chunkIndex}/${e.chunkTotal} done`,
          `Chunk complete: ${e.chunkIndex}/${e.chunkTotal}`,
          this.currentSession
        );
        break;
      }
      case "chunk-failed": {
        if (!this.currentSession) {
          break;
        }
        this.pushLog(
          `Chunk ${e.chunkIndex}/${e.chunkTotal} failed - click detail for more`,
          `Chunk failed: ${e.chunkIndex}/${e.chunkTotal} - ${e.message}`,
          this.currentSession
        );
        break;
      }
      case "file-upload-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Uploading file");
        this.pushLog(
          "Uploading file",
          "Uploading file to Google Gen AI",
          this.currentSession
        );
        break;
      }
      case "file-upload-complete": {
        if (!this.currentSession) {
          break;
        }
        const durationText = formatDuration(e.elapsedMs);
        this.pushLog(
          `File upload complete: ${durationText}`,
          `File upload complete: ${durationText}`,
          this.currentSession
        );
        break;
      }
      case "api-request-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Requesting API");
        this.pushLog(
          "API request start",
          "API request start",
          this.currentSession
        );
        break;
      }
      case "api-request-retry": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Retrying API");
        const retryMessage = e.message ? ` - ${e.message}` : "";
        this.pushLog(
          `API retry: attempt ${e.attempt}`,
          `API retry: attempt ${e.attempt}${retryMessage}`,
          this.currentSession
        );
        break;
      }
      case "api-request-complete": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("API done");
        const durationText = formatDuration(e.elapsedMs);
        this.pushLog(
          `API done: ${durationText}`,
          `API done: ${durationText}`,
          this.currentSession
        );
        break;
      }
      case "success": {
        if (!this.currentSession) {
          break;
        }
        const elapsed = this.currentSession.startedAtMs
          ? Date.now() - this.currentSession.startedAtMs
          : 0;
        this.currentSession.statusEl.setText("Success");
        const elapsedText = formatDuration(elapsed);
        this.pushLog(
          `Success: total ${elapsedText}`,
          `Success: total ${elapsedText}`,
          this.currentSession
        );
        // Update indicator to check icon
        this.updateIndicator(this.currentSession, "success");
        break;
      }
      case "error": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Failed");
        // Show short summary in status bar, full message in log detail
        this.pushLog(
          "API request failed - click detail for more",
          `Failed: ${e.message}`,
          this.currentSession
        );
        // Update indicator to error icon
        this.updateIndicator(this.currentSession, "error");
        break;
      }
    }
  }
}
