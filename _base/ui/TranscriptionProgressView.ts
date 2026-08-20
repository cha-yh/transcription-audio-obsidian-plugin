import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { progressBus } from "../utils/progressBus";
import { VIEW_ICON, VIEW_TITLE } from "../constants/progress";
import type { ProgressEvent } from "../types/progress";
import {
  formatBytes,
  formatDuration,
  formatTimeRange,
  formatTimestamp,
} from "../utils/format";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Above this many chunks the number labels collide, so they are dropped. */
const MAX_SPARKLINE_LABELS = 8;

interface SparklineChunk {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  speechRatio: number;
  skipped: boolean;
}

interface SparklineData {
  /** Speech-frame ratio per bucket, 0..1. */
  buckets: number[];
  totalMs: number;
  chunks: SparklineChunk[];
}

interface LogEntry {
  text: string;
  /** Set when this line represents a chunk result that can be re-run. */
  retryChunkIndex?: number;
  /** A newer result for the same chunk arrived; this button is dead. */
  retryStale?: boolean;
  retryRunning?: boolean;
  retryButtonEl?: HTMLButtonElement;
  /** Rendered as a bar chart instead of plain text. */
  sparkline?: SparklineData;
}

interface TranscriptionSession {
  sessionEl: HTMLElement;
  fileNameEl: HTMLAnchorElement;
  fileSizeEl: HTMLElement;
  statusEl: HTMLElement;
  targetFileEl: HTMLAnchorElement;
  modelEl: HTMLElement;
  categoryRowEl: HTMLElement;
  categoryEl: HTMLElement;
  transcriptRowEl: HTMLElement;
  transcriptFileEl: HTMLAnchorElement;
  transcriptPath?: string;
  chunkWrapEl?: HTMLElement;
  chunkBarEl?: HTMLProgressElement;
  chunkLabelEl?: HTMLElement;
  logEl: HTMLElement;
  latestLogEl: HTMLElement;
  detailButtonEl: HTMLButtonElement;
  cancelButtonEl: HTMLButtonElement;
  logHistoryEl: HTMLElement;
  indicatorEl: HTMLElement;
  logHistory: LogEntry[];
  pendingRetryChunks: Set<number>;
  /** Chunks that failed, so a successful re-run can advance the progress bar. */
  failedChunks: Set<number>;
  isLogExpanded: boolean;
  isCancellable: boolean;
  audioPath?: string;
  targetPath?: string;
  targetLine?: number;
  targetCh?: number;
  startedAtMs: number;
  chunkTotal: number;
  chunkIndex: number;
  chunksCompleted: number;
}

export class TranscriptionProgressView extends ItemView {
  private wrapperEl!: HTMLElement;
  private sessionsContainerEl!: HTMLElement;
  private currentSession?: TranscriptionSession;
  private pendingEvents: ProgressEvent[] = [];
  /** Keeps SVG pattern ids unique across sessions in the same document. */
  private sparklineSeq = 0;

  private formatLocaleDateTime(date: Date): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  private async openTargetFile(session: TranscriptionSession): Promise<void> {
    if (!session.targetPath) {
      return;
    }

    const abstractFile = this.app.vault.getAbstractFileByPath(
      session.targetPath
    );
    if (!(abstractFile instanceof TFile)) {
      new Notice(`Target file not found: ${session.targetPath}`);
      return;
    }

    const existingLeaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => {
        const view = leaf.view;
        return (
          view instanceof MarkdownView && view.file?.path === session.targetPath
        );
      });

    const leaf =
      existingLeaf ??
      this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);

    if (!existingLeaf) {
      await leaf.openFile(abstractFile, { active: true });
    }

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.app.workspace.revealLeaf(leaf);

    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const line = session.targetLine ?? 0;
      const ch = session.targetCh ?? 0;
      view.editor.setCursor({ line, ch });
      view.editor.focus();
    }
  }

  private async openFileByPath(path: string): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!(abstractFile instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }

    const leaf =
      this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);
    await leaf.openFile(abstractFile, { active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openAudioFile(session: TranscriptionSession): Promise<void> {
    if (!session.audioPath) {
      return;
    }

    const abstractFile = this.app.vault.getAbstractFileByPath(
      session.audioPath
    );
    if (!(abstractFile instanceof TFile)) {
      new Notice(`Audio file not found: ${session.audioPath}`);
      return;
    }

    const leaf =
      this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);
    await leaf.openFile(abstractFile, { active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.app.workspace.revealLeaf(leaf);
  }

  constructor(leaf: WorkspaceLeaf, private readonly viewType: string) {
    super(leaf);
  }

  getViewType(): string {
    return this.viewType;
  }
  getDisplayText(): string {
    return VIEW_TITLE;
  }
  getIcon(): string {
    return VIEW_ICON;
  }

  async onOpen(): Promise<void> {
    // contentEl, not containerEl: containerEl also holds Obsidian's
    // .view-header, and emptying it leaves that node orphaned — closing the
    // leaf then throws NotFoundError from removeChild. The view title is
    // rendered by that header, which is why there is no heading of our own.
    const { contentEl } = this;
    contentEl.empty();

    // Add top-level wrapper div
    this.wrapperEl = contentEl.createEl("div", {
      cls: "transcription-audio-wrapper",
    });
    this.wrapperEl.style.paddingLeft = "12px";
    this.wrapperEl.style.paddingRight = "12px";
    this.wrapperEl.style.paddingBottom = "40px";
    this.wrapperEl.style.height = "100%";
    this.wrapperEl.style.overflowY = "auto";

    // Container for all sessions
    this.sessionsContainerEl = this.wrapperEl.createEl("div", {
      cls: "transcription-audio-sessions",
    });

    this.register(progressBus.subscribe((e) => this.onProgress(e)));
  }

  /**
   * "1/3 - " for events belonging to a chunk, empty for whole-file requests.
   * Chunks run in parallel, so without this the log lines interleave with no
   * way to tell which chunk each one came from.
   *
   * Prefers the display numbering, which counts only the chunks actually sent —
   * a skipped range should not make three requests read as "of 4".
   */
  private chunkPrefix(e: {
    chunkIndex?: number;
    chunkTotal?: number;
    displayIndex?: number;
    displayTotal?: number;
  }): string {
    if (
      typeof e.displayIndex === "number" &&
      typeof e.displayTotal === "number"
    ) {
      return `${e.displayIndex}/${e.displayTotal} - `;
    }
    if (typeof e.chunkIndex !== "number" || typeof e.chunkTotal !== "number") {
      return "";
    }
    return `${e.chunkIndex}/${e.chunkTotal} - `;
  }

  /**
   * Maps each planned chunk to its position among the sent chunks, so the
   * sparkline reads "1 2 skip 3" rather than "1 2 skip 4".
   */
  private sentNumbering(chunks: SparklineChunk[]): Map<number, number> {
    const numbering = new Map<number, number>();
    let sent = 0;
    for (const chunk of chunks) {
      if (chunk.skipped) continue;
      sent += 1;
      numbering.set(chunk.chunkIndex, sent);
    }
    return numbering;
  }

  /** Denominator for the chunk progress bar: sent chunks, not planned ones. */
  private chunkDenominator(e: {
    chunkTotal: number;
    displayTotal?: number;
  }): number {
    return typeof e.displayTotal === "number" && e.displayTotal > 0
      ? e.displayTotal
      : e.chunkTotal;
  }

  private pushLog(
    summaryText: string,
    detailText: string,
    session: TranscriptionSession,
    options?: { retryChunkIndex?: number; sparkline?: SparklineData }
  ): void {
    const entry: LogEntry = {
      text: detailText,
      retryChunkIndex: options?.retryChunkIndex,
      sparkline: options?.sparkline,
    };

    // A chunk only ever has one live Retry button: the newest one. Older
    // entries for the same chunk describe a result that has been superseded.
    if (entry.retryChunkIndex !== undefined) {
      for (const previous of session.logHistory) {
        if (previous.retryChunkIndex === entry.retryChunkIndex) {
          previous.retryStale = true;
        }
      }
    }

    // Add to log history (always store full detail text)
    session.logHistory.push(entry);

    // Update status bar with summary (short message for quick glance)
    session.latestLogEl.setText(summaryText);

    // Add to log detail area if expanded
    if (session.isLogExpanded) {
      // Stale buttons live in already-rendered rows, so refresh them in place.
      if (entry.retryChunkIndex !== undefined) {
        this.refreshRetryButtons(session);
      }
      const line = this.renderLogLine(session, entry);
      line.scrollIntoView({ block: "end" });
    }
  }

  private renderLogLine(
    session: TranscriptionSession,
    entry: LogEntry
  ): HTMLElement {
    const line = session.logHistoryEl.createEl("div", {
      cls: "transcription-audio-log-line",
    });
    line.createEl("span", {
      text: entry.text,
      cls: "transcription-audio-log-line-text",
    });

    if (entry.text.includes("under 50 chars")) {
      line.style.color = "var(--text-error)";
    }

    if (entry.sparkline) {
      this.renderSparkline(session, entry.sparkline);
    }

    if (entry.retryChunkIndex === undefined) {
      return line;
    }

    const chunkIndex = entry.retryChunkIndex;
    const retryBtn = line.createEl("button", {
      text: "Retry",
      cls: "transcription-audio-log-retry-button",
    });
    entry.retryButtonEl = retryBtn;
    retryBtn.disabled = Boolean(entry.retryStale) || Boolean(entry.retryRunning);
    if (entry.retryRunning) {
      retryBtn.setText("Retrying...");
    }

    retryBtn.addEventListener("click", () => {
      entry.retryRunning = true;
      retryBtn.disabled = true;
      retryBtn.setText("Retrying...");
      session.pendingRetryChunks.add(chunkIndex);
      progressBus.publish({ stage: "chunk-rerun-requested", chunkIndex });
    });

    return line;
  }

  /**
   * Speech-activity bar chart. Drawn as inline SVG scaled by viewBox so it
   * fits whatever width the sidebar happens to be, with dividers marking
   * chunk boundaries so a quiet stretch can be tied to a chunk number.
   */
  private renderSparkline(
    session: TranscriptionSession,
    data: SparklineData
  ): void {
    const wrap = session.logHistoryEl.createEl("div", {
      cls: "transcription-audio-sparkline",
    });

    const width = 100;
    const height = 20;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.addClass("transcription-audio-sparkline-svg");

    const count = data.buckets.length;
    if (count > 0) {
      const barWidth = width / count;
      data.buckets.forEach((value, index) => {
        const clamped = Math.max(0, Math.min(1, value));
        // Keep a 1px stub for empty buckets so the timeline stays readable
        const barHeight = Math.max(0.75, clamped * height);
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", `${index * barWidth}`);
        rect.setAttribute("y", `${height - barHeight}`);
        rect.setAttribute("width", `${Math.max(barWidth - 0.15, 0.2)}`);
        rect.setAttribute("height", `${barHeight}`);
        rect.addClass(
          clamped < 0.05
            ? "transcription-audio-sparkline-bar-quiet"
            : "transcription-audio-sparkline-bar"
        );
        svg.appendChild(rect);
      });
    }

    const toX = (ms: number) =>
      data.totalMs > 0 ? (ms / data.totalMs) * width : 0;

    // Hatch the ranges that never reach the model, so "we skipped this" reads
    // differently from "this part was just quiet".
    const skippedChunks = data.chunks.filter((chunk) => chunk.skipped);
    if (skippedChunks.length > 0) {
      const patternId = `transcription-audio-hatch-${this.sparklineSeq++}`;
      const defs = document.createElementNS(SVG_NS, "defs");
      const pattern = document.createElementNS(SVG_NS, "pattern");
      pattern.setAttribute("id", patternId);
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.setAttribute("width", "2.5");
      pattern.setAttribute("height", "2.5");
      pattern.setAttribute("patternTransform", "rotate(45)");
      const stripe = document.createElementNS(SVG_NS, "line");
      stripe.setAttribute("x1", "0");
      stripe.setAttribute("y1", "0");
      stripe.setAttribute("x2", "0");
      stripe.setAttribute("y2", "2.5");
      stripe.addClass("transcription-audio-sparkline-hatch");
      pattern.appendChild(stripe);
      defs.appendChild(pattern);
      svg.appendChild(defs);

      for (const chunk of skippedChunks) {
        const x = toX(chunk.startMs);
        const w = Math.max(toX(chunk.endMs) - x, 0.4);
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", `${x}`);
        rect.setAttribute("y", "0");
        rect.setAttribute("width", `${w}`);
        rect.setAttribute("height", `${height}`);
        rect.setAttribute("fill", `url(#${patternId})`);
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = `${formatTimeRange(
          chunk.startMs,
          chunk.endMs
        )} — skipped, no speech detected`;
        rect.appendChild(title);
        svg.appendChild(rect);
      }
    }

    // Divider at every chunk boundary except the very start
    for (const chunk of data.chunks.slice(1)) {
      const x = toX(chunk.startMs);
      const divider = document.createElementNS(SVG_NS, "line");
      divider.setAttribute("x1", `${x}`);
      divider.setAttribute("x2", `${x}`);
      divider.setAttribute("y1", "0");
      divider.setAttribute("y2", `${height}`);
      divider.addClass("transcription-audio-sparkline-divider");
      svg.appendChild(divider);
    }

    wrap.appendChild(svg);

    // Chunk numbers only when they fit; the WAV path can plan dozens of chunks
    // and the labels would collide into noise.
    if (data.chunks.length > 0 && data.chunks.length <= MAX_SPARKLINE_LABELS) {
      const numbering = this.sentNumbering(data.chunks);
      const labels = wrap.createEl("div", {
        cls: "transcription-audio-sparkline-labels",
      });
      for (const chunk of data.chunks) {
        const mid = (toX(chunk.startMs) + toX(chunk.endMs)) / 2;
        const label = labels.createEl("span", {
          text: chunk.skipped
            ? "skip"
            : String(numbering.get(chunk.chunkIndex) ?? chunk.chunkIndex),
          cls: chunk.skipped
            ? "transcription-audio-sparkline-label-skip"
            : "transcription-audio-sparkline-label",
        });
        label.style.left = `${mid}%`;
      }
    }

    const scale = wrap.createEl("div", {
      cls: "transcription-audio-sparkline-scale",
    });
    scale.createEl("span", { text: "0:00" });
    scale.createEl("span", { text: formatTimestamp(data.totalMs) });

    this.renderChunkTimeline(wrap, session, data);
  }

  /**
   * Per-chunk rows under the chart. Skipped rows carry a button so a range the
   * detector wrote off can still be transcribed — the sparkline shows what was
   * dropped, this is how it gets undone.
   */
  private renderChunkTimeline(
    wrap: HTMLElement,
    session: TranscriptionSession,
    data: SparklineData
  ): void {
    if (data.chunks.length === 0) return;

    const skippedOnly = data.chunks.length > MAX_SPARKLINE_LABELS;
    const rows = data.chunks.filter((chunk) => !skippedOnly || chunk.skipped);
    if (rows.length === 0) return;

    const numbering = this.sentNumbering(data.chunks);
    const list = wrap.createEl("div", {
      cls: "transcription-audio-sparkline-rows",
    });

    for (const chunk of rows) {
      const row = list.createEl("div", {
        cls: chunk.skipped
          ? "transcription-audio-sparkline-row transcription-audio-sparkline-row-skip"
          : "transcription-audio-sparkline-row",
      });
      row.createEl("span", {
        text: `${
          chunk.skipped
            ? "–"
            : numbering.get(chunk.chunkIndex) ?? chunk.chunkIndex
        } ${formatTimeRange(chunk.startMs, chunk.endMs)}`,
        cls: "transcription-audio-sparkline-row-label",
      });

      if (!chunk.skipped) {
        // One decimal, because rounding hides the difference between a truly
        // empty range and one with stray detections in it.
        row.createEl("span", {
          text: `speech ${(chunk.speechRatio * 100).toFixed(1)}%`,
        });
        continue;
      }

      const button = row.createEl("button", {
        text: "Transcribe",
        cls: "transcription-audio-log-retry-button",
      });
      const chunkIndex = chunk.chunkIndex;
      button.addEventListener("click", () => {
        button.disabled = true;
        button.setText("Transcribing...");
        session.pendingRetryChunks.add(chunkIndex);
        progressBus.publish({ stage: "chunk-rerun-requested", chunkIndex });
      });
    }
  }

  /** Re-applies disabled/label state to buttons already in the DOM. */
  private refreshRetryButtons(session: TranscriptionSession): void {
    for (const entry of session.logHistory) {
      const button = entry.retryButtonEl;
      if (!button) continue;
      button.disabled = Boolean(entry.retryStale) || Boolean(entry.retryRunning);
      button.setText(entry.retryRunning ? "Retrying..." : "Retry");
    }
  }

  /** Clears the "Retrying..." state once a rerun settles. */
  private settleRetryButtons(
    session: TranscriptionSession,
    chunkIndex: number
  ): void {
    session.pendingRetryChunks.delete(chunkIndex);
    for (const entry of session.logHistory) {
      if (entry.retryChunkIndex === chunkIndex) {
        entry.retryRunning = false;
      }
    }
    this.refreshRetryButtons(session);
  }

  private createNewSession(): TranscriptionSession {
    const startedAtMs = Date.now();
    const startText = `Log start: ${this.formatLocaleDateTime(
      new Date(startedAtMs)
    )}`;

    // Create new session container (always add to the top)
    const newSessionEl = document.createElement("div");
    newSessionEl.className = "transcription-audio-session";

    // Insert before existing session if exists, otherwise append
    if (this.currentSession) {
      // The controller keeps retry context for the most recent run only, so
      // buttons from the previous session would target the wrong file.
      for (const entry of this.currentSession.logHistory) {
        if (entry.retryChunkIndex !== undefined) {
          entry.retryStale = true;
        }
      }
      this.refreshRetryButtons(this.currentSession);

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
    const fileNameEl = row1.createEl("a", {
      text: "-",
      cls: "internal-link transcription-audio-file-link is-disabled",
    });
    fileNameEl.href = "#";

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
    const targetFileEl = row4.createEl("a", {
      text: "-",
      cls: "internal-link transcription-audio-target-link is-disabled",
    });
    targetFileEl.href = "#";

    const row5 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row5.createEl("span", {
      text: "Model: ",
      cls: "transcription-audio-label",
    });
    const modelEl = row5.createEl("span", { text: "-" });

    const row6 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row6.createEl("span", {
      text: "Category: ",
      cls: "transcription-audio-label",
    });
    const categoryEl = row6.createEl("span", { text: "-" });
    row6.style.display = "none";

    const row7 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row7.createEl("span", {
      text: "Transcript: ",
      cls: "transcription-audio-label",
    });
    const transcriptFileEl = row7.createEl("a", {
      text: "-",
      cls: "internal-link transcription-audio-file-link is-disabled",
    });
    transcriptFileEl.href = "#";
    row7.style.display = "none";

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

    const cancelButtonEl = statusBarEl.createEl("button", {
      text: "cancel",
      cls: "transcription-audio-cancel-button",
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
      categoryRowEl: row6,
      categoryEl,
      transcriptRowEl: row7,
      transcriptFileEl,
      logEl,
      latestLogEl,
      detailButtonEl,
      cancelButtonEl,
      logHistoryEl,
      indicatorEl,
      logHistory: [{ text: startText }],
      pendingRetryChunks: new Set<number>(),
      failedChunks: new Set<number>(),
      isLogExpanded: false,
      isCancellable: true,
      audioPath: undefined,
      targetPath: undefined,
      targetLine: undefined,
      targetCh: undefined,
      startedAtMs,
      chunkTotal: 0,
      chunkIndex: 0,
      chunksCompleted: 0,
    };

    // Detail button click event - toggle only this session's log
    detailButtonEl.addEventListener("click", () => {
      this.toggleLogHistory(session);
    });

    fileNameEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.audioPath) {
        void this.openAudioFile(session);
      }
    });

    targetFileEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.targetPath) {
        void this.openTargetFile(session);
      }
    });

    transcriptFileEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.transcriptPath) {
        void this.openFileByPath(session.transcriptPath);
      }
    });

    cancelButtonEl.addEventListener("click", () => {
      if (!session.isCancellable) {
        return;
      }

      session.isCancellable = false;
      session.cancelButtonEl.disabled = true;
      session.cancelButtonEl.setText("cancelling...");
      session.statusEl.setText("Cancelling");
      this.pushLog("Cancelling", "Cancel requested by user", session);
      progressBus.publish({ stage: "cancel-requested" });
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
      // Buttons are recreated from scratch here, so their enabled/label state
      // has to come from the entry rather than the discarded DOM node.
      session.logHistory.forEach((entry) => {
        this.renderLogLine(session, entry);
      });
      session.detailButtonEl.setText("close");
    } else {
      // Collapse: hide history
      session.logHistoryEl.style.display = "none";
      session.detailButtonEl.setText("detail");
    }
  }

  /**
   * Standalone retry row for the classification and summarization steps, which
   * occur once per run. Chunk retries use the per-log-line button instead, since
   * several chunks can fail and each needs its own control.
   */
  private addRetryButton(
    session: TranscriptionSession,
    label: string,
    onRetry: () => void
  ): void {
    const retryRow = session.logEl.createEl("div", {
      cls: "transcription-audio-retry-row",
    });
    retryRow.createEl("span", {
      text: label,
      cls: "transcription-audio-retry-label",
    });
    const retryBtn = retryRow.createEl("button", {
      text: "Retry",
      cls: "transcription-audio-retry-button",
    });
    retryBtn.addEventListener("click", () => {
      retryBtn.disabled = true;
      retryBtn.setText("Retrying...");
      onRetry();
    });

    // Listen for result to re-enable or remove — register for auto-cleanup on view close
    const unsubscribe = progressBus.subscribe((event) => {
      // Classification/Summarization success — remove retry row
      if (
        event.stage === "classification-step-complete" ||
        event.stage === "summarization-step-complete"
      ) {
        retryRow.remove();
        unsubscribe();
        return;
      }
      // Classification/Summarization failure — re-enable retry button
      if (
        event.stage === "classification-step-failed" ||
        event.stage === "summarization-step-failed"
      ) {
        retryBtn.disabled = false;
        retryBtn.setText("Retry");
      }
    });
    this.register(unsubscribe);
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

  private finalizeCancellation(
    session: TranscriptionSession,
    label: string
  ): void {
    session.isCancellable = false;
    session.cancelButtonEl.disabled = true;
    session.cancelButtonEl.setText(label);
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
        session.targetPath = e.path;
        session.targetLine = e.line;
        session.targetCh = e.ch;
        session.targetFileEl.classList.remove("is-disabled");
        session.targetFileEl.setText(`${name} (${e.line}:${e.ch})`);
        session.targetFileEl.title = e.path;
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
        newSession.audioPath = e.fileName;
        newSession.fileNameEl.setText(name);
        newSession.fileNameEl.title = e.fileName;
        newSession.fileNameEl.classList.remove("is-disabled");
        newSession.statusEl.setText("File detected");
        this.pushLog(
          `File detected: ${name}`,
          `File detected: ${name}`,
          newSession
        );

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
      case "speech-activity": {
        if (!this.currentSession) {
          break;
        }

        const skipped = e.chunks.filter((c) => c.skipped);
        const sentCount = e.chunks.length - skipped.length;
        const skippedMs = skipped.reduce(
          (sum, c) => sum + (c.endMs - c.startMs),
          0
        );

        const summary =
          skipped.length > 0
            ? `Skipping ${formatTimestamp(skippedMs)} of silence`
            : "Speech activity analysed";
        const detail =
          skipped.length > 0
            ? `Speech analysed — ${sentCount} chunk(s) to transcribe, ${
                skipped.length
              } silent range(s) skipped (${formatTimestamp(skippedMs)})`
            : `Speech analysed — ${sentCount} chunk(s) to transcribe`;

        this.pushLog(summary, detail, this.currentSession, {
          sparkline: {
            buckets: e.buckets,
            totalMs: e.totalMs,
            chunks: e.chunks,
          },
        });

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
        this.currentSession.chunkTotal = this.chunkDenominator(e);
        this.currentSession.chunkIndex = e.displayIndex ?? e.chunkIndex;
        const rangeText = formatTimeRange(e.startMs, e.endMs);
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
            `Chunk ${this.currentSession.chunkIndex}/${this.currentSession.chunkTotal} running: ${rangeText}`
          );
        }
        this.currentSession.statusEl.setText("Transcribing chunk");
        this.pushLog(
          `${this.chunkPrefix(e)}Chunk start: ${rangeText}`,
          `${this.chunkPrefix(e)}Chunk start: ${rangeText}`,
          this.currentSession
        );
        break;
      }
      case "chunk-complete": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.chunksCompleted++;
        if (
          this.currentSession.chunkBarEl &&
          this.currentSession.chunkLabelEl
        ) {
          this.currentSession.chunkBarEl.max = this.chunkDenominator(e);
          this.currentSession.chunkBarEl.value =
            this.currentSession.chunksCompleted;
          this.currentSession.chunkLabelEl.setText(
            `${this.currentSession.chunksCompleted}/${this.chunkDenominator(
              e
            )} done`
          );
        }
        this.pushLog(
          `${this.chunkPrefix(e)}Chunk complete`,
          `${this.chunkPrefix(e)}Chunk complete`,
          this.currentSession
        );
        break;
      }
      case "chunk-short-response": {
        if (!this.currentSession) {
          break;
        }
        // renderLogLine colours "under 50 chars" lines red.
        const warnMsg = `${this.chunkPrefix(
          e
        )}Transcription under 50 chars (${e.charCount} chars)`;
        this.pushLog(warnMsg, warnMsg, this.currentSession);
        break;
      }
      case "chunk-failed": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.failedChunks.add(e.chunkIndex);
        // The Retry button rides on the log line itself, so several failed
        // chunks each keep their own control.
        this.pushLog(
          `${this.chunkPrefix(e)}Chunk failed`,
          `${this.chunkPrefix(e)}Chunk failed: ${e.message}`,
          this.currentSession,
          { retryChunkIndex: e.chunkIndex }
        );
        break;
      }
      case "chunk-rerun-complete": {
        if (!this.currentSession) {
          break;
        }
        this.settleRetryButtons(this.currentSession, e.chunkIndex);

        // Recovering a failed chunk is real progress; re-running one that had
        // already succeeded is not, so only the former moves the counter.
        if (e.success && this.currentSession.failedChunks.delete(e.chunkIndex)) {
          this.currentSession.chunksCompleted++;
          if (this.currentSession.chunkBarEl) {
            this.currentSession.chunkBarEl.value =
              this.currentSession.chunksCompleted;
          }
        }

        // chunk-start put the bar label into "running" and the status into
        // "Transcribing chunk"; a re-run emits no chunk-complete, so restore
        // them here instead of leaving the session looking mid-flight.
        this.currentSession.statusEl.setText(
          e.success ? "Chunk re-run done" : "Chunk re-run failed"
        );
        if (this.currentSession.chunkLabelEl) {
          this.currentSession.chunkLabelEl.setText(
            `${this.currentSession.chunksCompleted}/${this.chunkDenominator(
              e
            )} done`
          );
        }

        if (e.success) {
          const delta =
            typeof e.previousLength === "number" &&
            typeof e.newLength === "number"
              ? ` (${e.previousLength} → ${e.newLength} chars)`
              : "";
          this.pushLog(
            `${this.chunkPrefix(e)}Chunk re-run complete`,
            `${this.chunkPrefix(e)}Chunk re-run complete${delta} — transcription file updated, summary not regenerated`,
            this.currentSession,
            { retryChunkIndex: e.chunkIndex }
          );
        } else {
          this.pushLog(
            `${this.chunkPrefix(e)}Chunk re-run failed`,
            `${this.chunkPrefix(e)}Chunk re-run failed: ${
              e.message ?? "unknown error"
            }`,
            this.currentSession,
            { retryChunkIndex: e.chunkIndex }
          );
        }
        break;
      }
      case "file-upload-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Uploading file");
        this.pushLog(
          `${this.chunkPrefix(e)}Uploading file`,
          `${this.chunkPrefix(e)}Uploading file to Google Gen AI`,
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
          `${this.chunkPrefix(e)}File upload complete: ${durationText}`,
          `${this.chunkPrefix(e)}File upload complete: ${durationText}`,
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
          `${this.chunkPrefix(e)}API request start`,
          `${this.chunkPrefix(e)}API request start`,
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
          `${this.chunkPrefix(e)}API retry: attempt ${e.attempt}`,
          `${this.chunkPrefix(e)}API retry: attempt ${e.attempt}${retryMessage}`,
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
          `${this.chunkPrefix(e)}API done: ${durationText}`,
          `${this.chunkPrefix(e)}API done: ${durationText}`,
          this.currentSession
        );
        break;
      }
      case "api-usage": {
        if (!this.currentSession) {
          break;
        }

        const usageParts: string[] = [];
        if (typeof e.promptTokenCount === "number") {
          usageParts.push(`prompt ${e.promptTokenCount}`);
        }
        if (typeof e.candidatesTokenCount === "number") {
          usageParts.push(`output ${e.candidatesTokenCount}`);
        }
        if (typeof e.thoughtsTokenCount === "number") {
          usageParts.push(`thoughts ${e.thoughtsTokenCount}`);
        }
        if (typeof e.toolUsePromptTokenCount === "number") {
          usageParts.push(`tool ${e.toolUsePromptTokenCount}`);
        }
        if (typeof e.totalTokenCount === "number") {
          usageParts.push(`total ${e.totalTokenCount}`);
        }

        if (usageParts.length > 0) {
          this.pushLog(
            `${this.chunkPrefix(e)}Usage recorded`,
            `${this.chunkPrefix(e)}Usage: ${usageParts.join(", ")} tokens`,
            this.currentSession,
            { retryChunkIndex: e.retryable ? e.chunkIndex : undefined }
          );
        }

        break;
      }
      case "transcription-step-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Transcribing");
        this.pushLog(
          "Step 1: Transcription started",
          "Step 1: Transcribing audio to raw text",
          this.currentSession
        );
        break;
      }
      case "transcription-step-complete": {
        if (!this.currentSession) {
          break;
        }
        const durationText = formatDuration(e.elapsedMs);
        this.pushLog(
          `Step 1: Transcription done: ${durationText}`,
          `Step 1: Transcription complete: ${durationText}`,
          this.currentSession
        );
        break;
      }
      case "temp-file-created": {
        if (!this.currentSession) {
          break;
        }
        const fileName = e.path.split("/").pop() || e.path;
        this.currentSession.transcriptPath = e.path;
        this.currentSession.transcriptRowEl.style.display = "";
        this.currentSession.transcriptFileEl.setText(fileName);
        this.currentSession.transcriptFileEl.title = e.path;
        this.currentSession.transcriptFileEl.classList.remove("is-disabled");
        this.pushLog(
          `Transcript: ${fileName}`,
          `Transcription saved to: ${e.path}`,
          this.currentSession
        );
        break;
      }
      case "classification-step-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Classifying");
        this.pushLog(
          "Step 2: Classification started",
          "Step 2: Classifying transcript category",
          this.currentSession
        );
        break;
      }
      case "classification-step-complete": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.categoryRowEl.style.display = "";
        this.currentSession.categoryEl.setText(e.category);
        const durationText = formatDuration(e.elapsedMs);
        this.pushLog(
          `Step 2: Category: ${e.category} (${durationText})`,
          `Step 2: Classification complete: ${e.category} (${durationText})`,
          this.currentSession
        );
        break;
      }
      case "summarization-step-start": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Summarizing");
        this.pushLog(
          "Step 3: Summarization started",
          "Step 3: Summarizing transcription with category prompt",
          this.currentSession
        );
        break;
      }
      case "summarization-step-complete": {
        if (!this.currentSession) {
          break;
        }
        const durationText = formatDuration(e.elapsedMs);
        this.pushLog(
          `Step 3: Summarization done: ${durationText}`,
          `Step 3: Summarization complete: ${durationText}`,
          this.currentSession
        );
        break;
      }
      case "classification-step-failed": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Classification failed");
        this.pushLog(
          "Step 2: Classification failed",
          `Step 2: Classification failed - ${e.message}`,
          this.currentSession
        );
        this.addRetryButton(
          this.currentSession,
          "Classification failed",
          () => {
            progressBus.publish({ stage: "classification-retry-requested" });
          }
        );
        break;
      }
      case "summarization-step-failed": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Summarization failed");
        this.pushLog(
          "Step 3: Summarization failed",
          `Step 3: Summarization failed - ${e.message}`,
          this.currentSession
        );
        this.addRetryButton(
          this.currentSession,
          "Summarization failed",
          () => {
            progressBus.publish({ stage: "summarization-retry-requested" });
          }
        );
        break;
      }
      case "cancel-requested": {
        if (!this.currentSession) {
          break;
        }
        if (!this.currentSession.isCancellable) {
          break;
        }
        this.currentSession.isCancellable = false;
        this.currentSession.cancelButtonEl.disabled = true;
        this.currentSession.cancelButtonEl.setText("cancelling...");
        this.currentSession.statusEl.setText("Cancelling");
        this.pushLog(
          "Cancelling",
          "Cancel requested by user",
          this.currentSession
        );
        break;
      }
      case "cancelled": {
        if (!this.currentSession) {
          break;
        }
        this.currentSession.statusEl.setText("Cancelled");
        this.pushLog(
          "Cancelled by user",
          "Cancelled by user",
          this.currentSession
        );
        this.updateIndicator(this.currentSession, "error");
        this.finalizeCancellation(this.currentSession, "cancelled");
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
        this.finalizeCancellation(this.currentSession, "done");
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
        this.finalizeCancellation(this.currentSession, "failed");
        break;
      }
    }
  }
}
