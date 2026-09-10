import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { progressBus } from "../utils/progressBus";
import { VIEW_ICON, VIEW_TITLE } from "../constants/progress";
import type { ProgressEvent } from "../types/progress";
import {
  formatBytes,
  formatDuration,
  formatLocaleDateTime,
  formatTimeRange,
  formatTimestamp,
} from "../utils/format";
import type {
  SessionStatus,
  PersistedSession,
  PersistedSparkline,
  PersistedSparklineChunk,
} from "../types/sessionHistory";
import {
  createInitialSession,
  fromSnapshot,
  isRemovableStatus,
  resolveHistoryLimit,
  toSnapshot,
  type RuntimeLogEntry,
  type SessionRuntimeState,
} from "../utils/sessionSnapshot";
import { TERMINAL_STAGES } from "../constants/sessionHistory";
import type { ProgressHistoryStore } from "../services/session/ProgressHistoryStore";
import type { AudioPluginSettings } from "../types/setting";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Anything that is not a clean success reads as an error icon. */
function indicatorStatusOf(
  status: SessionStatus
): "success" | "loading" | "error" {
  if (status === "success") return "success";
  if (status === "running") return "loading";
  return "error";
}
/** Above this many chunks the number labels collide, so they are dropped. */
const MAX_SPARKLINE_LABELS = 8;

type SparklineChunk = PersistedSparklineChunk;
type SparklineData = PersistedSparkline;

interface LogEntry extends RuntimeLogEntry {
  retryButtonEl?: HTMLButtonElement;
}

/**
 * The DOM half of a session. Kept apart from the state half so that what gets
 * written to disk is visible in the type: anything here is a node, anything in
 * SessionRuntimeState is a value that survives a reload.
 */
interface SessionRefs {
  sessionEl: HTMLElement;
  closeButtonEl: HTMLButtonElement;
  /** Chunk re-run buttons under the sparkline, refreshed when they go stale. */
  chunkRerunButtonEls: HTMLButtonElement[];
  fileNameEl: HTMLAnchorElement;
  fileSizeEl: HTMLElement;
  statusEl: HTMLElement;
  targetFileEl: HTMLAnchorElement;
  modelEl: HTMLElement;
  categoryRowEl: HTMLElement;
  categoryEl: HTMLElement;
  transcriptRowEl: HTMLElement;
  transcriptFileEl: HTMLAnchorElement;
  chunkWrapEl?: HTMLElement;
  chunkBarEl?: HTMLProgressElement;
  chunkLabelEl?: HTMLElement;
  logEl: HTMLElement;
  latestLogEl: HTMLElement;
  detailButtonEl: HTMLButtonElement;
  cancelButtonEl: HTMLButtonElement;
  logHistoryEl: HTMLElement;
  indicatorEl: HTMLElement;
}

/**
 * Flat on purpose: `session.statusEl` and `session.logHistory` are read in
 * well over a hundred places, and nesting the state would rename every one of
 * them for no behavioural gain.
 */
type TranscriptionSession = SessionRefs &
  Omit<SessionRuntimeState, "logHistory"> & { logHistory: LogEntry[] };

export class TranscriptionProgressView extends ItemView {
  private wrapperEl!: HTMLElement;
  private sessionsContainerEl!: HTMLElement;
  private currentSession?: TranscriptionSession;
  /** Newest first; [0] is the current session while a run is going. */
  private sessions: TranscriptionSession[] = [];
  /** Disambiguates two runs that start in the same millisecond. */
  private sessionSeq = 0;
  private pendingEvents: ProgressEvent[] = [];
  /** Keeps SVG pattern ids unique across sessions in the same document. */
  private sparklineSeq = 0;

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

  constructor(
    leaf: WorkspaceLeaf,
    private readonly viewType: string,
    private readonly store: ProgressHistoryStore,
    /** A getter, not a value: the toggles change while the view is open. */
    private readonly getSettings: () => AudioPluginSettings
  ) {
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

    // Subscribed before restoring: the controller opens this view as it starts
    // a run, so a later subscription would miss that run's file-detected.
    this.register(progressBus.subscribe((e) => this.onProgress(e)));
    const source = () => this.sessions.map(toSnapshot);
    this.register(() => {
      void this.store.flush();
      this.store.clearSource(source);
    });
    this.store.setSource(source);

    this.restoreSessions();
  }

  /**
   * Draws what the store already holds in memory. The file itself is read once
   * per plugin load, not here — reopening the sidebar mid-run must keep the
   * live session rather than replace it with a stale copy of itself.
   */
  private restoreSessions(): void {
    this.sessions = [];
    this.currentSession = undefined;

    for (const snapshot of this.store.list()) {
      const session = this.renderSession(fromSnapshot(snapshot));
      this.sessionsContainerEl.appendChild(session.sessionEl);
      this.sessions.push(session);
    }

    // A session still marked running means the plugin never unloaded, so the
    // run it belongs to is still going and its events should keep landing.
    const newest = this.sessions[0];
    if (newest && newest.status === "running") {
      this.currentSession = newest;
    }
  }

  /**
   * "1/3 - " for events belonging to a chunk, empty for whole-file requests.
   * Chunks run in parallel, so without this the log lines interleave with no
   * way to tell which chunk each one came from.
   *
   * Prefers the display numbering, which counts only the chunks actually sent —
   * a skipped range should not make three requests read as "of 4".
   */
  /**
   * A run that was never cut up reads as one file, so the "1/1 -" numbering
   * and the word "chunk" would both be noise. Short recordings go up whole and
   * are retried whole; they are numbered as a single chunk only so the retry
   * machinery has something to address.
   */
  private isSingleChunk(e: {
    chunkTotal?: number;
    displayTotal?: number;
  }): boolean {
    return (e.displayTotal ?? e.chunkTotal) === 1;
  }

  private rerunLabel(e: { chunkTotal?: number; displayTotal?: number }): string {
    return this.isSingleChunk(e) ? "Re-run" : "Chunk re-run";
  }

  private chunkPrefix(e: {
    chunkIndex?: number;
    chunkTotal?: number;
    displayIndex?: number;
    displayTotal?: number;
  }): string {
    if (this.isSingleChunk(e)) {
      return "";
    }
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
    this.setLatestLog(session, summaryText);

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
      session.chunkRerunButtonEls.push(button);
      // Dead once the controller has moved on: the rerun context it would
      // drive belongs to whichever run is current, so a click here would
      // rewrite that run's transcript instead of this one's.
      button.disabled = Boolean(session.rerunDisabled);
      button.addEventListener("click", () => {
        if (session.rerunDisabled) return;
        button.disabled = true;
        button.setText("Transcribing...");
        session.pendingRetryChunks.add(chunkIndex);
        progressBus.publish({ stage: "chunk-rerun-requested", chunkIndex });
      });
    }
  }

  /** Re-applies disabled/label state to buttons already in the DOM. */
  /** Marks a run as no longer re-runnable and updates every button it owns. */
  private disableReruns(session: TranscriptionSession): void {
    session.rerunDisabled = true;
    for (const entry of session.logHistory) {
      if (entry.retryChunkIndex !== undefined) entry.retryStale = true;
    }
    this.refreshRetryButtons(session);
  }

  private refreshRetryButtons(session: TranscriptionSession): void {
    for (const button of session.chunkRerunButtonEls) {
      if (session.rerunDisabled) button.disabled = true;
    }
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

  /**
   * Builds one session's DOM from its state. A fresh run and a record restored
   * from disk both come through here, so anything filled in only on the live
   * path is something that will not survive a reload.
   */
  private renderSession(state: SessionRuntimeState): TranscriptionSession {
    const sessionEl = document.createElement("div");
    sessionEl.className = "transcription-audio-session";

    const headerEl = sessionEl.createEl("div", {
      cls: "transcription-audio-session-header",
    });
    headerEl.createEl("span", {
      text: formatLocaleDateTime(new Date(state.startedAtMs)),
      cls: "transcription-audio-session-date",
    });
    const closeButtonEl = headerEl.createEl("button", {
      text: "\u00d7",
      cls: "transcription-audio-session-close-button",
      attr: { "aria-label": "Remove this record", title: "Remove this record" },
    });
    // A run still going keeps its cancel button instead. Removing the card
    // would take away the only way to stop the work it is still doing.
    closeButtonEl.hidden = !isRemovableStatus(state.status);

    const infoEl = sessionEl.createEl("div", {
      cls: "transcription-audio-info",
    });

    const row1 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row1.createEl("span", { text: "File: ", cls: "transcription-audio-label" });
    const fileNameEl = row1.createEl("a", {
      text: state.audioName ?? "-",
      cls: "internal-link transcription-audio-file-link",
    });
    fileNameEl.href = "#";
    if (state.audioPath) {
      fileNameEl.title = state.audioPath;
    } else {
      fileNameEl.classList.add("is-disabled");
    }

    const row2 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row2.createEl("span", { text: "Size: ", cls: "transcription-audio-label" });
    const fileSizeEl = row2.createEl("span", { text: state.fileSizeText });

    const row3 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row3.createEl("span", {
      text: "Status: ",
      cls: "transcription-audio-label",
    });
    const statusEl = row3.createEl("span", { text: state.statusText });

    const row4 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row4.createEl("span", {
      text: "Target: ",
      cls: "transcription-audio-label",
    });
    const targetFileEl = row4.createEl("a", {
      text: state.targetPath
        ? `${state.targetPath.split("/").pop() || state.targetPath} (${
            state.targetLine ?? 0
          }:${state.targetCh ?? 0})`
        : "-",
      cls: "internal-link transcription-audio-target-link",
    });
    targetFileEl.href = "#";
    if (state.targetPath) {
      targetFileEl.title = state.targetPath;
    } else {
      targetFileEl.classList.add("is-disabled");
    }

    const row5 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row5.createEl("span", {
      text: "Model: ",
      cls: "transcription-audio-label",
    });
    const modelEl = row5.createEl("span", { text: state.modelText });

    const row6 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row6.createEl("span", {
      text: "Category: ",
      cls: "transcription-audio-label",
    });
    const categoryEl = row6.createEl("span", { text: state.categoryText ?? "-" });
    row6.style.display = state.categoryText === undefined ? "none" : "";

    const row7 = infoEl.createEl("div", { cls: "transcription-audio-row" });
    row7.createEl("span", {
      text: "Transcript: ",
      cls: "transcription-audio-label",
    });
    const transcriptFileEl = row7.createEl("a", {
      text: state.transcriptPath
        ? state.transcriptPath.split("/").pop() || state.transcriptPath
        : "-",
      cls: "internal-link transcription-audio-file-link",
    });
    transcriptFileEl.href = "#";
    if (state.transcriptPath) {
      transcriptFileEl.title = state.transcriptPath;
    } else {
      transcriptFileEl.classList.add("is-disabled");
    }
    row7.style.display = state.transcriptPath === undefined ? "none" : "";

    const logEl = sessionEl.createEl("div", { cls: "transcription-audio-log" });

    const statusBarEl = logEl.createEl("div", {
      cls: "transcription-audio-latest-log",
    });
    const indicatorEl = statusBarEl.createEl("div", {
      cls: "transcription-audio-indicator",
    });
    const latestLogEl = statusBarEl.createEl("span", {
      text: state.latestLogText,
      cls: "transcription-audio-latest-log-text",
    });
    const detailButtonEl = statusBarEl.createEl("button", {
      text: state.isLogExpanded ? "close" : "detail",
      cls: "transcription-audio-detail-button",
    });
    const cancelButtonEl = statusBarEl.createEl("button", {
      text: state.cancelLabel,
      cls: "transcription-audio-cancel-button",
    });
    cancelButtonEl.disabled = !state.isCancellable;

    const logHistoryEl = logEl.createEl("div", {
      cls: "transcription-audio-log-history",
    });
    logHistoryEl.style.display = state.isLogExpanded ? "block" : "none";

    const session = Object.assign(state, {
      sessionEl,
      closeButtonEl,
      chunkRerunButtonEls: [],
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
    }) as TranscriptionSession;

    this.updateIndicator(session, indicatorStatusOf(state.status));
    if (state.chunkLabelText !== undefined) {
      this.ensureChunkUi(session);
    }
    if (state.isLogExpanded) {
      this.renderLogHistory(session);
    }
    this.attachSessionHandlers(session);
    return session;
  }

  private attachSessionHandlers(session: TranscriptionSession): void {
    session.detailButtonEl.addEventListener("click", () => {
      this.toggleLogHistory(session);
    });

    session.closeButtonEl.addEventListener("click", () => {
      // Guarded rather than trusting `hidden`: an author-level `display` rule
      // from Obsidian or a theme overrides the UA stylesheet's [hidden], and a
      // button that is merely painted over is still focusable and clickable.
      if (!isRemovableStatus(session.status)) return;
      this.removeSession(session);
    });

    session.fileNameEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.audioPath) {
        void this.openAudioFile(session);
      }
    });

    session.targetFileEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.targetPath) {
        void this.openTargetFile(session);
      }
    });

    session.transcriptFileEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (session.transcriptPath) {
        void this.openFileByPath(session.transcriptPath);
      }
    });

    session.cancelButtonEl.addEventListener("click", () => {
      if (!session.isCancellable) {
        return;
      }

      this.setCancelState(session, false, "cancelling...");
      this.setStatus(session, "Cancelling");
      this.pushLog("Cancelling", "Cancel requested by user", session);
      progressBus.publish({ stage: "cancel-requested" });
    });
  }

  /** Chunk progress only appears once a run reports its first chunk. */
  private ensureChunkUi(session: TranscriptionSession): void {
    if (session.chunkWrapEl) return;

    session.chunkWrapEl = session.sessionEl.createEl("div", {
      cls: "transcription-audio-chunks",
    });
    session.chunkLabelEl = session.chunkWrapEl.createEl("div", {
      text: session.chunkLabelText ?? "Chunk: -",
    });
    session.chunkBarEl = session.chunkWrapEl.createEl("progress");
    session.chunkBarEl.max = session.chunkBarMax;
    session.chunkBarEl.value = session.chunkBarValue;
  }

  private createNewSession(): TranscriptionSession {
    if (this.currentSession) {
      // The controller keeps retry context for the most recent run only, so
      // buttons from the previous session would target the wrong file.
      this.disableReruns(this.currentSession);
    }

    const session = this.renderSession({
      ...fromSnapshot(createInitialSession(Date.now(), this.sessionSeq++)),
      rerunDisabled: false,
    });
    // Anchored to the container rather than to currentSession: after a restore
    // there are older cards but no current session, and appending would file
    // the new run underneath them. insertBefore(el, null) appends anyway.
    this.sessionsContainerEl.insertBefore(
      session.sessionEl,
      this.sessionsContainerEl.firstChild
    );
    this.sessions.unshift(session);
    this.currentSession = session;
    this.applyRetention();
    return session;
  }

  /**
   * Redraws the whole expanded log. Buttons are recreated from scratch, so
   * their enabled state has to come from the entry rather than the DOM node
   * that was just discarded.
   */
  private renderLogHistory(session: TranscriptionSession): void {
    session.logHistoryEl.style.display = "block";
    session.logHistoryEl.empty();
    session.logHistory.forEach((entry) => {
      this.renderLogLine(session, entry);
    });
    session.detailButtonEl.setText("close");
  }

  private toggleLogHistory(session: TranscriptionSession): void {
    session.isLogExpanded = !session.isLogExpanded;

    if (session.isLogExpanded) {
      this.renderLogHistory(session);
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

  /**
   * Every one of these writes the state field beside the DOM node. Skipping
   * the state half is how a value ends up visible but unsaved, which is the
   * bug this whole feature exists to fix.
   */
  private setStatus(session: TranscriptionSession, text: string): void {
    session.statusText = text;
    session.statusEl.setText(text);
  }

  private setLatestLog(session: TranscriptionSession, text: string): void {
    session.latestLogText = text;
    session.latestLogEl.setText(text);
  }

  private setFileSize(session: TranscriptionSession, bytes: number): void {
    session.fileSizeText = formatBytes(bytes);
    session.fileSizeEl.setText(session.fileSizeText);
  }

  private setModel(session: TranscriptionSession, model: string): void {
    session.modelText = model;
    session.modelEl.setText(model);
  }

  private setCategory(session: TranscriptionSession, category: string): void {
    session.categoryText = category;
    session.categoryEl.setText(category);
    session.categoryRowEl.style.display = "";
  }

  private setAudioFile(session: TranscriptionSession, path: string): void {
    session.audioPath = path;
    session.audioName = path.split("/").pop() || path;
    session.fileNameEl.setText(session.audioName);
    session.fileNameEl.title = path;
    session.fileNameEl.classList.remove("is-disabled");
  }

  private setTargetFile(
    session: TranscriptionSession,
    path: string,
    line: number,
    ch: number
  ): void {
    session.targetPath = path;
    session.targetLine = line;
    session.targetCh = ch;
    session.targetFileEl.classList.remove("is-disabled");
    session.targetFileEl.setText(
      `${path.split("/").pop() || path} (${line}:${ch})`
    );
    session.targetFileEl.title = path;
  }

  private setTranscriptFile(
    session: TranscriptionSession,
    path: string
  ): void {
    session.transcriptPath = path;
    session.transcriptFileEl.setText(path.split("/").pop() || path);
    session.transcriptFileEl.title = path;
    session.transcriptFileEl.classList.remove("is-disabled");
    session.transcriptRowEl.style.display = "";
  }

  private setChunkProgress(
    session: TranscriptionSession,
    max: number,
    value: number,
    labelText: string
  ): void {
    session.chunkBarMax = max;
    session.chunkBarValue = value;
    session.chunkLabelText = labelText;
    this.ensureChunkUi(session);
    if (session.chunkBarEl) {
      session.chunkBarEl.max = max;
      session.chunkBarEl.value = value;
    }
    session.chunkLabelEl?.setText(labelText);
  }

  private setCancelState(
    session: TranscriptionSession,
    isCancellable: boolean,
    label: string
  ): void {
    session.isCancellable = isCancellable;
    session.cancelLabel = label;
    session.cancelButtonEl.disabled = !isCancellable;
    session.cancelButtonEl.setText(label);
  }

  /**
   * Ends a run: records when it stopped and reveals the remove button, which
   * stays hidden while there is still work that could be cancelled instead.
   */
  private finalizeSession(
    session: TranscriptionSession,
    status: SessionStatus,
    cancelLabel: string
  ): void {
    session.status = status;
    session.endedAtMs = Date.now();
    this.setCancelState(session, false, cancelLabel);
    this.updateIndicator(session, indicatorStatusOf(status));
    session.closeButtonEl.hidden = !isRemovableStatus(status);
  }

  private removeSession(session: TranscriptionSession): void {
    session.sessionEl.remove();
    this.sessions = this.sessions.filter((entry) => entry !== session);
    if (this.currentSession === session) {
      // Not reassigned to the next card: a late event such as a chunk re-run
      // result would then land on an unrelated older run. Leaving it empty
      // lets the existing guards drop those events, and the next
      // file-detected starts a fresh session anyway.
      this.currentSession = undefined;
    }
    void this.store.flush();
  }

  /**
   * Trims the panel to the configured number of records. A run in progress is
   * always at index 0 and the limit never drops below one, so it cannot prune
   * itself away.
   */
  private applyRetention(): void {
    const settings = this.getSettings();
    const limit = resolveHistoryLimit(settings);
    if (limit === undefined || this.sessions.length <= limit) return;

    for (const session of this.sessions.slice(limit)) {
      session.sessionEl.remove();
    }
    this.sessions = this.sessions.slice(0, limit);
    if (this.currentSession && this.sessions.indexOf(this.currentSession) < 0) {
      this.currentSession = undefined;
    }
  }

  /** Called by the settings tab so a lowered limit takes effect at once. */
  applyHistorySettings(): void {
    this.applyRetention();
    void this.store.flush();
  }

  /**
   * Re-adds records the store holds but the panel is not showing, which is
   * what switching history back on looks like: the file survived being off,
   * and saving the panel as-is would otherwise overwrite it.
   */
  mergeRestored(snapshots: PersistedSession[]): void {
    const known: Record<string, true> = {};
    for (const session of this.sessions) {
      known[session.id] = true;
    }

    for (const snapshot of snapshots) {
      if (known[snapshot.id]) continue;
      const session = this.renderSession(fromSnapshot(snapshot));
      this.sessions.push(session);
    }

    this.sessions.sort((a, b) => b.startedAtMs - a.startedAtMs);
    // appendChild moves an existing node, so this reorders the cards in place.
    for (const session of this.sessions) {
      this.sessionsContainerEl.appendChild(session.sessionEl);
    }
    this.applyRetention();
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
        this.setModel(session, e.model);
        this.pushLog(`Model: ${e.model}`, `Model: ${e.model}`, session);
        break;
      }
      case "target-file-selected": {
        const name = e.path.split("/").pop() || e.path;
        this.setTargetFile(session, e.path, e.line, e.ch);
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
    this.handleProgress(e);

    // A finished run is worth writing at once; anything else can wait for the
    // debounce, since a run emits events far faster than a file should be
    // rewritten.
    if (TERMINAL_STAGES.indexOf(e.stage) >= 0) {
      void this.store.flush();
    } else {
      this.store.schedule();
    }
  }

  private handleProgress(e: ProgressEvent): void {
    switch (e.stage) {
      case "file-detected": {
        // Start new transcription session - add new session container to the top
        const newSession = this.createNewSession();
        const name = e.fileName.split("/").pop() || e.fileName;
        this.setAudioFile(newSession, e.fileName);
        this.setStatus(newSession, "File detected");
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
        this.setFileSize(this.currentSession, e.sizeBytes);
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
        this.setStatus(this.currentSession, "Preparing audio");
        this.pushLog("Preparing audio", "Preparing audio", this.currentSession);
        break;
      }
      case "audio-decode-unavailable": {
        if (!this.currentSession) {
          break;
        }
        // Not an error: the run continues with the original file. Saying so
        // matters because the transcript will not be split into chunks.
        const msg = `Cannot decode this audio here (${e.message}) — sending the original file in one request, without splitting`;
        this.pushLog(msg, msg, this.currentSession);
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
        if (this.isSingleChunk(e)) {
          // No progress bar either: a bar that only ever reads 1/1 says less
          // than the status line already does.
          this.setStatus(this.currentSession, "Transcribing");
          this.pushLog(
            "Transcribing audio",
            "Transcribing audio",
            this.currentSession
          );
          break;
        }
        this.currentSession.chunkTotal = this.chunkDenominator(e);
        this.currentSession.chunkIndex = e.displayIndex ?? e.chunkIndex;
        const rangeText = formatTimeRange(e.startMs, e.endMs);
        this.setChunkProgress(
          this.currentSession,
          this.currentSession.chunkTotal,
          // Chunks run in parallel, so the bar must never walk backwards.
          Math.max(
            this.currentSession.chunkBarValue,
            this.currentSession.chunkIndex - 1
          ),
          `Chunk ${this.currentSession.chunkIndex}/${this.currentSession.chunkTotal} running: ${rangeText}`
        );
        this.setStatus(this.currentSession, "Transcribing chunk");
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
        this.setChunkProgress(
          this.currentSession,
          this.chunkDenominator(e),
          this.currentSession.chunksCompleted,
          `${this.currentSession.chunksCompleted}/${this.chunkDenominator(
            e
          )} done`
        );
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
        const failureLabel = this.isSingleChunk(e)
          ? "Transcription failed"
          : `${this.chunkPrefix(e)}Chunk failed`;
        this.pushLog(
          failureLabel,
          `${failureLabel}: ${e.message}`,
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
        }

        // chunk-start put the bar label into "running" and the status into
        // "Transcribing chunk"; a re-run emits no chunk-complete, so restore
        // them here instead of leaving the session looking mid-flight.
        this.setStatus(
          this.currentSession,
          this.isSingleChunk(e)
            ? e.success
              ? "Re-run done"
              : "Re-run failed"
            : e.success
            ? "Chunk re-run done"
            : "Chunk re-run failed"
        );
        if (this.currentSession.chunkLabelText !== undefined) {
          this.setChunkProgress(
            this.currentSession,
            this.chunkDenominator(e),
            this.currentSession.chunksCompleted,
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
            `${this.chunkPrefix(e)}${this.rerunLabel(e)} complete`,
            `${this.chunkPrefix(e)}${this.rerunLabel(
              e
            )} complete${delta} — transcription file updated, summary not regenerated`,
            this.currentSession,
            { retryChunkIndex: e.chunkIndex }
          );
        } else {
          this.pushLog(
            `${this.chunkPrefix(e)}${this.rerunLabel(e)} failed`,
            `${this.chunkPrefix(e)}${this.rerunLabel(e)} failed: ${
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
        this.setStatus(this.currentSession, "Uploading file");
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
        this.setStatus(this.currentSession, "Requesting API");
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
        this.setStatus(this.currentSession, "Retrying API");
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
        this.setStatus(this.currentSession, "API done");
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
        this.setStatus(this.currentSession, "Transcribing");
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
        this.setTranscriptFile(this.currentSession, e.path);
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
        this.setStatus(this.currentSession, "Classifying");
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
        this.setCategory(this.currentSession, e.category);
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
        this.setStatus(this.currentSession, "Summarizing");
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
        this.setStatus(this.currentSession, "Classification failed");
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
        this.setStatus(this.currentSession, "Summarization failed");
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
        this.setCancelState(this.currentSession, false, "cancelling...");
        this.setStatus(this.currentSession, "Cancelling");
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
        this.setStatus(this.currentSession, "Cancelled");
        this.pushLog(
          "Cancelled by user",
          "Cancelled by user",
          this.currentSession
        );
        this.finalizeSession(this.currentSession, "cancelled", "cancelled");
        break;
      }
      case "success": {
        if (!this.currentSession) {
          break;
        }
        const elapsed = this.currentSession.startedAtMs
          ? Date.now() - this.currentSession.startedAtMs
          : 0;
        this.setStatus(this.currentSession, "Success");
        const elapsedText = formatDuration(elapsed);
        this.pushLog(
          `Success: total ${elapsedText}`,
          `Success: total ${elapsedText}`,
          this.currentSession
        );
        this.finalizeSession(this.currentSession, "success", "done");
        break;
      }
      case "error": {
        if (!this.currentSession) {
          break;
        }
        this.setStatus(this.currentSession, "Failed");
        // Show short summary in status bar, full message in log detail
        this.pushLog(
          "API request failed - click detail for more",
          `Failed: ${e.message}`,
          this.currentSession
        );
        this.finalizeSession(this.currentSession, "error", "failed");
        break;
      }
    }
  }
}
