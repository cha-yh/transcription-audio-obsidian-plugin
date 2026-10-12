import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { progressBus } from "../utils/progressBus";
import { VIEW_ICON, VIEW_TITLE } from "../constants/progress";
import type { ProgressEvent } from "../types/progress";
import {
  formatBytes,
  formatDuration,
  formatLocaleDateTime,
  formatLogDateTime,
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
import {
  reduceSummaryProgress,
  type SummaryProgress,
} from "../utils/summaryProgress";
import {
  applyRunProgressEvent,
  createRunProgress,
  isInFlight,
  type ChunkPhase,
  type RunProgress,
} from "../utils/runProgress";

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
/** Bars in the placeholder drawn while the audio is still being prepared. */
const SKELETON_BAR_COUNT = 48;
/** How often the placeholder bars pick new heights. */
const SKELETON_SHUFFLE_MS = 1000;

/** A placeholder bar height between 40% and 60%. */
function skeletonBarHeight(): string {
  return `${40 + Math.random() * 20}%`;
}

/**
 * A chunk failed and the controller can still re-run it. The progress area
 * holds the only Retry buttons, so it stays open while this holds.
 */
function needsRetry(state: {
  progress?: RunProgress;
  rerunDisabled?: boolean;
}): boolean {
  if (!state.progress || state.rerunDisabled) return false;
  for (const phase of Array.from(state.progress.chunkPhases.values())) {
    if (phase === "failed") return true;
  }
  return false;
}
const SHOW_LOGS_LABEL = "Show logs";
const HIDE_LOGS_LABEL = "Hide logs";

type SparklineChunk = PersistedSparklineChunk;
type SparklineData = PersistedSparkline;

type LogEntry = RuntimeLogEntry;

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
  targetFileEl: HTMLAnchorElement;
  categoryRowEl: HTMLElement;
  categoryEl: HTMLElement;
  transcriptRowEl: HTMLElement;
  transcriptFileEl: HTMLAnchorElement;
  summaryRowEl: HTMLElement;
  summaryFileEl: HTMLAnchorElement;
  /** Classification, summarization and the prompt editor. */
  progressSummaryEl: HTMLElement;
  /** What the user typed into the prompt editor and has not sent yet. */
  summaryPromptDraft?: string;
  summaryPromptOpen: boolean;
  /**
   * A summary request sent from this card outside any run, still in flight:
   * rewriting a finished run's summary, or finishing one a run left undone.
   */
  summaryRequest?: "rewrite" | "finish";
  logEl: HTMLElement;
  latestLogEl: HTMLElement;
  detailButtonEl: HTMLButtonElement;
  cancelButtonEl: HTMLButtonElement;
  logHistoryEl: HTMLElement;
  indicatorEl: HTMLElement;
  /** The status row; clicking it shows or hides the progress area. */
  statusBarEl: HTMLElement;
  progressToggleEl: HTMLElement;
  /**
   * Opens when a run starts or a chunk needs a retry; only the user closes
   * it. Not persisted: a rebuilt panel opens the cards that are running or
   * waiting for a retry and leaves the rest closed.
   */
  isProgressExpanded: boolean;
  progressEl: HTMLElement;
  progressChartEl: HTMLElement;
  /** Chunk-state layer over the chart; rebuilt without touching the bars. */
  progressOverlayEl?: HTMLElement;
  progressStatusEl: HTMLElement;
  /**
   * Which chart is drawn. The bars are rebuilt only when this changes, so a
   * chunk update does not restart the skeleton animation.
   */
  progressChartKey?: "skeleton" | "chart" | "none";
  /** Placeholder bars, re-heightened on a timer while they are shown. */
  skeletonBarEls?: HTMLElement[];
}

/** How one chunk reads in the progress area. */
type ChunkView = ChunkPhase | "pending" | "skipped" | "stopped";

const CHUNK_VIEW_TEXT: Record<ChunkView, string> = {
  pending: "Waiting",
  starting: "Preparing...",
  uploading: "Uploading...",
  transcribing: "Transcribing...",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped, no speech",
  stopped: "Stopped",
};

/**
 * Flat on purpose: `session.statusText` and `session.logHistory` are read in
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
  /**
   * The card a summary request borrowed `currentSession` from, restored when
   * the request settles. `null` means there was none.
   */
  private sessionBeforeSummaryRerun?: TranscriptionSession | null;
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

    this.registerInterval(
      window.setInterval(() => this.shuffleSkeletons(), SKELETON_SHUFFLE_MS)
    );
  }

  /** Gives every visible placeholder chart new bar heights. */
  private shuffleSkeletons(): void {
    for (const session of this.sessions) {
      if (!session.isProgressExpanded || !session.skeletonBarEls) continue;
      for (const bar of session.skeletonBarEls) {
        bar.style.height = skeletonBarHeight();
      }
    }
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
      atMs: Date.now(),
      retryChunkIndex: options?.retryChunkIndex,
      sparkline: options?.sparkline,
    };

    // Only the newest result for a chunk is current; older entries describe
    // one that has been superseded.
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
    if (entry.atMs !== undefined) {
      line.createEl("span", {
        text: formatLogDateTime(new Date(entry.atMs)),
        cls: "transcription-audio-log-line-time",
      });
    }
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

    // Chunk re-runs are offered in the progress area, not on log lines.
    return line;
  }

  /**
   * Speech-activity bars with chunk-boundary dividers, as inline SVG scaled by
   * viewBox so it fits whatever width the sidebar happens to be.
   */
  private createSpeechChartSvg(data: SparklineData): SVGSVGElement {
    const width = 100;
    const height = 32;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.addClass("transcription-audio-sparkline-svg");

    const count = data.buckets.length;
    if (count > 0) {
      const barWidth = width / count;
      data.buckets.forEach((value, index) => {
        const clamped = Math.max(0, Math.min(1, value));
        // Square root lifts the low ratios sparse speech produces (~10-30%)
        // into visible bars while keeping 0 and 1 where they were.
        // Keep a 1px stub for empty buckets so the timeline stays readable
        const barHeight = Math.max(1, Math.sqrt(clamped) * height);
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

    // Divider at every chunk boundary except the very start
    for (const chunk of data.chunks.slice(1)) {
      const x = data.totalMs > 0 ? (chunk.startMs / data.totalMs) * width : 0;
      const divider = document.createElementNS(SVG_NS, "line");
      divider.setAttribute("x1", `${x}`);
      divider.setAttribute("x2", `${x}`);
      divider.setAttribute("y1", "0");
      divider.setAttribute("y2", `${height}`);
      divider.addClass("transcription-audio-sparkline-divider");
      svg.appendChild(divider);
    }

    return svg;
  }

  /**
   * Chunk numbers under the chart, only when they fit; the WAV path can plan
   * dozens of chunks and the labels would collide into noise.
   */
  private renderChunkLabels(wrap: HTMLElement, data: SparklineData): void {
    if (data.chunks.length === 0 || data.chunks.length > MAX_SPARKLINE_LABELS) {
      return;
    }
    const toPercent = (ms: number) =>
      data.totalMs > 0 ? (ms / data.totalMs) * 100 : 0;
    const numbering = this.sentNumbering(data.chunks);
    const labels = wrap.createEl("div", {
      cls: "transcription-audio-sparkline-labels",
    });
    for (const chunk of data.chunks) {
      const mid = (toPercent(chunk.startMs) + toPercent(chunk.endMs)) / 2;
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

  private renderTimeScale(wrap: HTMLElement, totalMs: number): void {
    const scale = wrap.createEl("div", {
      cls: "transcription-audio-sparkline-scale",
    });
    scale.createEl("span", { text: "0:00" });
    scale.createEl("span", { text: formatTimestamp(totalMs) });
  }

  /**
   * The chart as older records stored it, inside a log entry. New runs draw
   * it in the progress area instead.
   */
  private renderSparkline(
    session: TranscriptionSession,
    data: SparklineData
  ): void {
    const wrap = session.logHistoryEl.createEl("div", {
      cls: "transcription-audio-sparkline",
    });

    const width = 100;
    const height = 32;
    const svg = this.createSpeechChartSvg(data);

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

    wrap.appendChild(svg);
    this.renderChunkLabels(wrap, data);
    this.renderTimeScale(wrap, data.totalMs);
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

  /**
   * Feeds an event to the summary section. A summary requested from a card
   * outside any run borrows `currentSession` for its events, and gives it
   * back once the request settles.
   */
  private updateSummaryProgress(e: ProgressEvent): void {
    const session = this.currentSession;
    if (!session) return;
    const next = reduceSummaryProgress(session.summary, e);
    if (next === session.summary) return;
    session.summary = next;

    if (e.stage === "summarization-step-start") {
      // Show what was sent; an unsent edit is superseded by it
      session.summaryPromptDraft = undefined;
    }
    if (
      e.stage === "classification-step-failed" ||
      e.stage === "summarization-step-failed"
    ) {
      // The Retry for these is in the progress area
      if (!session.isProgressExpanded) {
        session.isProgressExpanded = true;
        this.renderProgress(session);
      }
    }
    this.renderSummarySection(session);
  }

  /**
   * Ends a summary request made from a card outside any run, once its last
   * event is in, and gives `currentSession` back to the card it was
   * borrowed from. Runs after every other handler, so that last event still
   * lands on the requesting card.
   */
  private settleSummaryRequest(e: ProgressEvent): void {
    const session = this.currentSession;
    const request = session?.summaryRequest;
    if (!session || !request) return;
    const settled =
      request === "rewrite"
        ? e.stage === "summary-file-created" ||
          e.stage === "summarization-step-failed"
        : e.stage === "success" ||
          e.stage === "error" ||
          e.stage === "cancelled";
    if (!settled) return;

    session.summaryRequest = undefined;
    if (this.sessionBeforeSummaryRerun !== undefined) {
      this.currentSession = this.sessionBeforeSummaryRerun ?? undefined;
      this.sessionBeforeSummaryRerun = undefined;
    }
    this.refreshSummarySections();
  }

  /**
   * Redraws every card's summary section. Whether a summary can be requested
   * depends on whether anything else is running, so a run starting or ending
   * changes it on cards it never touches.
   */
  private refreshSummarySections(): void {
    for (const session of this.sessions) {
      this.renderSummarySection(session);
    }
  }

  /** Some run, or a summary request, is still in flight somewhere. */
  private isAnyRunBusy(): boolean {
    return this.sessions.some(
      (session) =>
        session.status === "running" || session.summaryRequest !== undefined
    );
  }

  /**
   * Whether a summary request can be sent from this card now. A run that is
   * still going takes it as the retry it is waiting for; otherwise it needs
   * the transcript and nothing else in flight.
   */
  private canRequestSummary(session: TranscriptionSession): boolean {
    if (session.status === "running") return true;
    return Boolean(session.transcriptPath) && !this.isAnyRunBusy();
  }

  /**
   * Sends a classification or summary retry from the card, picking the
   * request that fits where its run stands:
   * - still running: the retry the run is waiting for;
   * - finished with success: rewrite the summary file with `prompt`;
   * - ended without a summary: finish the job, including the note insert.
   * Without `prompt` the summary goes through classification again.
   */
  private requestSummary(
    session: TranscriptionSession,
    step: "classify" | "summarize",
    prompt?: string
  ): void {
    if (session.status === "running") {
      progressBus.publish(
        step === "classify"
          ? { stage: "classification-retry-requested" }
          : { stage: "summarization-retry-requested", prompt }
      );
      return;
    }

    const transcriptPath = session.transcriptPath;
    if (!transcriptPath || this.isAnyRunBusy()) return;
    const rewrite = session.status === "success" && prompt !== undefined;

    // Borrow currentSession so the request's events land on this card
    if (this.currentSession !== session) {
      this.sessionBeforeSummaryRerun = this.currentSession ?? null;
      this.currentSession = session;
    }
    session.summaryRequest = rewrite ? "rewrite" : "finish";
    this.refreshSummarySections();

    if (rewrite) {
      progressBus.publish({
        stage: "summary-rerun-requested",
        transcriptPath,
        summaryPath: session.summary?.path,
        prompt: prompt!,
      });
      return;
    }
    progressBus.publish({
      stage: "summary-finish-requested",
      transcriptPath,
      prompt,
      target: session.targetPath
        ? {
            path: session.targetPath,
            line: session.targetLine ?? 0,
            ch: session.targetCh ?? 0,
          }
        : undefined,
    });
  }

  private addSummaryRetryButton(
    row: HTMLElement,
    session: TranscriptionSession,
    onClick: () => void
  ): void {
    const button = row.createEl("button", {
      text: "Retry",
      cls: "transcription-audio-log-retry-button",
    });
    button.disabled = !this.canRequestSummary(session);
    button.addEventListener("click", () => {
      if (!this.canRequestSummary(session)) return;
      button.disabled = true;
      onClick();
    });
  }

  /**
   * Classification and summarization with the prompt behind them. A failed
   * or stopped step carries Retry on its row; the prompt can be edited and
   * sent from below, which also rewrites a finished run's summary.
   */
  private renderSummarySection(session: TranscriptionSession): void {
    const el = session.progressSummaryEl;
    el.empty();
    const summary = session.summary;
    el.style.display = summary ? "" : "none";
    if (!summary) return;

    const inFlight =
      session.status === "running" || session.summaryRequest !== undefined;
    const stepView = (phase: SummaryProgress["phase"]) =>
      phase === "running" && !inFlight ? "stopped" : phase;
    const promptToSend = () => session.summaryPromptDraft ?? summary.prompt;

    el.createEl("div", {
      text: "Summary",
      cls: "transcription-audio-summary-title",
    });

    if (summary.classify) {
      const view = stepView(summary.classify.phase);
      const text =
        view === "running"
          ? "Classifying..."
          : view === "done"
          ? summary.classify.category
            ? `Category: ${summary.classify.category}`
            : "No category matched, default prompt"
          : view === "failed"
          ? "Failed"
          : "Stopped";
      const row = this.renderSummaryRow(el, "Classify", view, text);
      if (view === "failed" || view === "stopped") {
        this.addSummaryRetryButton(row, session, () =>
          this.requestSummary(session, "classify")
        );
      }
    }

    if (summary.phase) {
      const view = stepView(summary.phase);
      const text =
        view === "running"
          ? "Summarizing..."
          : view === "done"
          ? "Done"
          : view === "failed"
          ? "Failed"
          : "Stopped";
      const row = this.renderSummaryRow(el, "Summarize", view, text);
      if (view === "failed" || view === "stopped") {
        this.addSummaryRetryButton(row, session, () =>
          this.requestSummary(session, "summarize", promptToSend())
        );
      }
    }

    if (summary.prompt === undefined) return;

    const details = el.createEl("details", {
      cls: "transcription-audio-summary-prompt",
    });
    details.open = session.summaryPromptOpen;
    details.addEventListener("toggle", () => {
      session.summaryPromptOpen = details.open;
    });
    details.createEl("summary", { text: "Prompt" });
    const textarea = details.createEl("textarea", {
      cls: "transcription-audio-summary-prompt-input",
    });
    textarea.value = promptToSend() ?? "";
    textarea.rows = 6;

    const actions = details.createEl("div", {
      cls: "transcription-audio-summary-prompt-actions",
    });
    const failed = summary.phase === "failed";
    const button = actions.createEl("button", {
      text: failed ? "Retry with this prompt" : "Summarize again",
      cls: "transcription-audio-log-retry-button",
    });
    const canSend = () =>
      textarea.value.trim().length > 0 &&
      summary.phase !== "running" &&
      // A running run only takes a prompt as the retry of a failed summary
      (session.status !== "running" || failed) &&
      this.canRequestSummary(session);
    button.disabled = !canSend();
    textarea.addEventListener("input", () => {
      session.summaryPromptDraft = textarea.value;
      button.disabled = !canSend();
    });
    button.addEventListener("click", () => {
      if (!canSend()) return;
      button.disabled = true;
      this.requestSummary(session, "summarize", textarea.value);
    });
  }

  private renderSummaryRow(
    el: HTMLElement,
    label: string,
    view: string | undefined,
    text: string
  ): HTMLElement {
    const row = el.createEl("div", {
      cls: `transcription-audio-progress-row transcription-audio-progress-row-${
        view === "running" ? "transcribing" : view
      }`,
    });
    row.createEl("span", {
      text: label,
      cls: "transcription-audio-progress-row-label",
    });
    const state = row.createEl("span", {
      cls: "transcription-audio-progress-row-state",
    });
    state.createEl("span", { cls: "transcription-audio-progress-dot" });
    state.createEl("span", { text });
    return row;
  }

  /** Feeds an event to the current run's progress area and redraws on change. */
  private updateRunProgress(e: ProgressEvent): void {
    const session = this.currentSession;
    if (!session?.progress) return;
    let changed = applyRunProgressEvent(session.progress, e);
    // A failed chunk opens the area so its Retry button is in view. Never
    // closes it: only the user does that.
    if (
      (e.stage === "chunk-failed" || e.stage === "chunk-rerun-complete") &&
      needsRetry(session) &&
      !session.isProgressExpanded
    ) {
      session.isProgressExpanded = true;
      changed = true;
    }
    if (changed) {
      this.renderProgress(session);
    }
  }

  /**
   * Progress area under the status row. Records written before it existed
   * have no progress state, so theirs holds only the log.
   */
  private renderProgress(session: TranscriptionSession): void {
    const progress = session.progress;
    const expanded = session.isProgressExpanded;
    session.progressEl.style.display = expanded ? "" : "none";
    session.progressToggleEl.toggleClass("is-expanded", expanded);
    session.statusBarEl.addClass("is-toggleable");
    session.statusBarEl.setAttribute("role", "button");
    session.statusBarEl.setAttribute("tabindex", "0");
    session.statusBarEl.setAttribute("aria-expanded", String(expanded));
    session.statusBarEl.title = expanded ? "Hide progress" : "Show progress";
    if (!progress) return;

    const key = this.progressChartKeyOf(session, progress);
    if (key !== session.progressChartKey) {
      session.progressChartKey = key;
      this.renderProgressChart(session, progress, key);
    }
    this.renderProgressStatus(session, progress);
  }

  private progressChartKeyOf(
    session: TranscriptionSession,
    progress: RunProgress
  ): "skeleton" | "chart" | "none" {
    if (progress.sparkline) return "chart";
    // A run that ended without analysis (decode failed, or an existing
    // transcript was reused) has nothing left to wait for.
    if (progress.chartUnavailable || session.status !== "running") {
      return "none";
    }
    return "skeleton";
  }

  private renderProgressChart(
    session: TranscriptionSession,
    progress: RunProgress,
    key: "skeleton" | "chart" | "none"
  ): void {
    const el = session.progressChartEl;
    el.empty();
    session.progressOverlayEl = undefined;
    session.skeletonBarEls = undefined;

    if (key === "none") {
      if (progress.chartUnavailable) {
        el.createEl("div", {
          text: "No chart: this audio cannot be decoded here",
          cls: "transcription-audio-progress-note",
        });
      }
      return;
    }

    const box = el.createEl("div", {
      cls: "transcription-audio-progress-chart",
    });

    if (key === "skeleton") {
      const bars = box.createEl("div", {
        cls: "transcription-audio-progress-skeleton",
      });
      session.skeletonBarEls = Array.from({ length: SKELETON_BAR_COUNT }, () => {
        const bar = bars.createEl("div", {
          cls: "transcription-audio-progress-skeleton-bar",
        });
        bar.style.height = skeletonBarHeight();
        return bar;
      });
      return;
    }

    const data = progress.sparkline!;
    box.appendChild(this.createSpeechChartSvg(data));
    session.progressOverlayEl = box.createEl("div", {
      cls: "transcription-audio-progress-overlays",
    });
    this.renderChunkLabels(el, data);
    this.renderTimeScale(el, data.totalMs);
  }

  /**
   * The chunks the area tracks. A whole-file run plans no chunks, so it is
   * shown as one chunk spanning the recording, numbered 1 like everywhere else.
   */
  private progressChunks(progress: RunProgress): SparklineChunk[] {
    const planned = progress.sparkline?.chunks ?? [];
    if (planned.length > 0) return planned;
    const totalMs = progress.sparkline?.totalMs ?? 0;
    return Array.from(progress.chunkPhases.keys())
      .sort((a, b) => a - b)
      .map((chunkIndex) => ({
        chunkIndex,
        startMs: 0,
        endMs: totalMs,
        speechRatio: 0,
        skipped: false,
      }));
  }

  private chunkViewOf(
    session: TranscriptionSession,
    chunk: SparklineChunk,
    phase: ChunkPhase | undefined
  ): ChunkView {
    // A skipped range that was transcribed later is tracked like any other
    if (phase === undefined) return chunk.skipped ? "skipped" : "pending";
    // Work in flight when the run ended is not coming back
    if (isInFlight(phase) && session.status !== "running") return "stopped";
    return phase;
  }

  private renderProgressStatus(
    session: TranscriptionSession,
    progress: RunProgress
  ): void {
    const statusEl = session.progressStatusEl;
    statusEl.empty();
    session.progressOverlayEl?.empty();

    const chunks = this.progressChunks(progress);
    const totalMs = progress.sparkline?.totalMs ?? 0;
    const toPercent = (ms: number) => (totalMs > 0 ? (ms / totalMs) * 100 : 0);
    const isWholeFile =
      chunks.filter((chunk) => !chunk.skipped).length <= 1 &&
      chunks.length <= 1;
    const numbering = this.sentNumbering(chunks);
    const views = chunks.map((chunk) => ({
      chunk,
      view: this.chunkViewOf(
        session,
        chunk,
        progress.chunkPhases.get(chunk.chunkIndex)
      ),
    }));

    if (views.length > 0) {
      // Thin per-chunk strip under the chart; spans the full width when the
      // recording length is unknown.
      const strip = statusEl.createEl("div", {
        cls: "transcription-audio-progress-strip",
      });
      for (const { chunk, view } of views) {
        const left = totalMs > 0 ? toPercent(chunk.startMs) : 0;
        const width = totalMs > 0 ? toPercent(chunk.endMs) - left : 100;
        const segment = strip.createEl("div", {
          cls: `transcription-audio-progress-segment transcription-audio-progress-${view}`,
        });
        segment.style.left = `${left}%`;
        segment.style.width = `${Math.max(width, 0.5)}%`;

        if (
          session.progressOverlayEl &&
          totalMs > 0 &&
          view !== "pending" &&
          view !== "done"
        ) {
          const overlay = session.progressOverlayEl.createEl("div", {
            cls: `transcription-audio-progress-overlay transcription-audio-progress-overlay-${view}`,
          });
          overlay.style.left = `${left}%`;
          overlay.style.width = `${Math.max(width, 0.5)}%`;
        }
      }

      // Long plans list only what needs attention; the strip shows the rest
      const showAll = views.length <= MAX_SPARKLINE_LABELS;
      const rows = views.filter(
        ({ view }) => showAll || (view !== "done" && view !== "pending")
      );
      if (rows.length > 0) {
        const list = statusEl.createEl("div", {
          cls: "transcription-audio-progress-rows",
        });
        for (const { chunk, view } of rows) {
          this.renderProgressRow(list, session, chunk, view, {
            isWholeFile,
            number: numbering.get(chunk.chunkIndex),
          });
        }
      }
    }
  }

  private renderProgressRow(
    list: HTMLElement,
    session: TranscriptionSession,
    chunk: SparklineChunk,
    view: ChunkView,
    options: { isWholeFile: boolean; number?: number }
  ): void {
    const row = list.createEl("div", {
      cls: `transcription-audio-progress-row transcription-audio-progress-row-${view}`,
    });
    const label = options.isWholeFile
      ? "Audio"
      : `${
          chunk.skipped && view === "skipped"
            ? "–"
            : options.number ?? chunk.chunkIndex
        } · ${formatTimeRange(chunk.startMs, chunk.endMs)}`;
    row.createEl("span", {
      text: label,
      cls: "transcription-audio-progress-row-label",
    });

    const state = row.createEl("span", {
      cls: "transcription-audio-progress-row-state",
    });
    state.createEl("span", {
      cls: "transcription-audio-progress-dot",
    });
    state.createEl("span", { text: CHUNK_VIEW_TEXT[view] });

    if (view !== "failed" && view !== "skipped") return;

    const chunkIndex = chunk.chunkIndex;
    const button = row.createEl("button", {
      text: view === "failed" ? "Retry" : "Transcribe",
      cls: "transcription-audio-log-retry-button",
    });
    // Dead once the controller has moved on: the rerun context belongs to
    // whichever run is current, so a click here would rewrite that run's
    // transcript instead of this one's.
    button.disabled =
      Boolean(session.rerunDisabled) ||
      session.pendingRetryChunks.has(chunkIndex);
    button.addEventListener("click", () => {
      if (session.rerunDisabled) return;
      button.disabled = true;
      session.pendingRetryChunks.add(chunkIndex);
      progressBus.publish({ stage: "chunk-rerun-requested", chunkIndex });
    });
  }

  /** Marks a run as no longer re-runnable and updates every button it owns. */
  private disableReruns(session: TranscriptionSession): void {
    session.rerunDisabled = true;
    for (const entry of session.logHistory) {
      if (entry.retryChunkIndex !== undefined) entry.retryStale = true;
    }
    this.refreshRetryButtons(session);
    this.renderProgress(session);
  }

  private refreshRetryButtons(session: TranscriptionSession): void {
    for (const button of session.chunkRerunButtonEls) {
      if (session.rerunDisabled) button.disabled = true;
    }
  }

  /** Re-enables a chunk's buttons once its rerun settles. */
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
    this.renderProgress(session);
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
    row1.createEl("span", { text: "Audio: ", cls: "transcription-audio-label" });
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

    const summaryPath = state.summary?.path;
    const summaryRowEl = infoEl.createEl("div", {
      cls: "transcription-audio-row",
    });
    summaryRowEl.createEl("span", {
      text: "Summary: ",
      cls: "transcription-audio-label",
    });
    const summaryFileEl = summaryRowEl.createEl("a", {
      text: summaryPath ? summaryPath.split("/").pop() || summaryPath : "-",
      cls: "internal-link transcription-audio-file-link",
    });
    summaryFileEl.href = "#";
    if (summaryPath) summaryFileEl.title = summaryPath;
    summaryRowEl.style.display = summaryPath === undefined ? "none" : "";

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
    const progressToggleEl = statusBarEl.createEl("span", {
      cls: "transcription-audio-progress-toggle",
    });
    progressToggleEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    const cancelButtonEl = statusBarEl.createEl("button", {
      text: state.cancelLabel,
      cls: "transcription-audio-cancel-button",
    });
    cancelButtonEl.disabled = !state.isCancellable;

    // Under the status row and folded with it: chart, chunk state, then the
    // log as the detail beneath them
    const progressEl = logEl.createEl("div", {
      cls: "transcription-audio-progress",
    });
    const progressChartEl = progressEl.createEl("div");
    const progressStatusEl = progressEl.createEl("div");
    const progressSummaryEl = progressEl.createEl("div", {
      cls: "transcription-audio-summary",
    });

    const logsBarEl = progressEl.createEl("div", {
      cls: "transcription-audio-progress-logs",
    });
    const detailButtonEl = logsBarEl.createEl("button", {
      text: state.isLogExpanded ? HIDE_LOGS_LABEL : SHOW_LOGS_LABEL,
      cls: "transcription-audio-detail-button",
    });

    const logHistoryEl = progressEl.createEl("div", {
      cls: "transcription-audio-log-history",
    });
    logHistoryEl.style.display = state.isLogExpanded ? "block" : "none";

    const session = Object.assign(state, {
      sessionEl,
      closeButtonEl,
      chunkRerunButtonEls: [],
      fileNameEl,
      targetFileEl,
      categoryRowEl: row6,
      categoryEl,
      transcriptRowEl: row7,
      transcriptFileEl,
      summaryRowEl,
      summaryFileEl,
      progressSummaryEl,
      summaryPromptOpen: false,
      logEl,
      latestLogEl,
      detailButtonEl,
      cancelButtonEl,
      logHistoryEl,
      indicatorEl,
      statusBarEl,
      progressToggleEl,
      isProgressExpanded: state.status === "running" || needsRetry(state),
      progressEl,
      progressChartEl,
      progressStatusEl,
    }) as TranscriptionSession;

    this.updateIndicator(session, indicatorStatusOf(state.status));
    this.renderProgress(session);
    this.renderSummarySection(session);
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

    const toggleProgress = () => {
      session.isProgressExpanded = !session.isProgressExpanded;
      this.renderProgress(session);
    };
    session.statusBarEl.addEventListener("click", (event) => {
      // The cancel button sits in the same row
      if ((event.target as HTMLElement).closest("button")) return;
      toggleProgress();
    });
    session.statusBarEl.addEventListener("keydown", (event) => {
      if (event.target !== session.statusBarEl) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleProgress();
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

    session.summaryFileEl.addEventListener("click", (event) => {
      event.preventDefault();
      const path = session.summary?.path;
      if (path) void this.openFileByPath(path);
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
    this.refreshSummarySections();
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
    session.detailButtonEl.setText(HIDE_LOGS_LABEL);
  }

  private toggleLogHistory(session: TranscriptionSession): void {
    session.isLogExpanded = !session.isLogExpanded;

    if (session.isLogExpanded) {
      this.renderLogHistory(session);
    } else {
      // Collapse: hide history
      session.logHistoryEl.style.display = "none";
      session.detailButtonEl.setText(SHOW_LOGS_LABEL);
    }
  }

  /**
   * Every one of these writes the state field beside the DOM node. Skipping
   * the state half is how a value ends up visible but unsaved, which is the
   * bug this whole feature exists to fix.
   *
   * Status, size, model and chunk progress are no longer drawn on the card,
   * but they stay in the saved record so older records still load unchanged.
   */
  private setStatus(session: TranscriptionSession, text: string): void {
    session.statusText = text;
  }

  private setLatestLog(session: TranscriptionSession, text: string): void {
    session.latestLogText = text;
    session.latestLogEl.setText(text);
  }

  private setFileSize(session: TranscriptionSession, bytes: number): void {
    session.fileSizeText = formatBytes(bytes);
  }

  private setModel(session: TranscriptionSession, model: string): void {
    session.modelText = model;
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

  private setSummaryFile(session: TranscriptionSession, path: string): void {
    session.summaryFileEl.setText(path.split("/").pop() || path);
    session.summaryFileEl.title = path;
    session.summaryRowEl.style.display = "";
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
    this.renderProgress(session);
    this.refreshSummarySections();
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
    this.updateRunProgress(e);
    this.updateSummaryProgress(e);
    this.settleSummaryRequest(e);

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

        // The chart itself is drawn in the progress area, not in the log.
        this.pushLog(summary, detail, this.currentSession);

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
        // Reported even at 0, so a missed cache is visible too
        if (typeof e.cachedContentTokenCount === "number") {
          usageParts.push(`cached ${e.cachedContentTokenCount}`);
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
        if (!this.currentSession.progress) {
          this.currentSession.progress = createRunProgress();
          this.renderProgress(this.currentSession);
        }
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
      case "transcript-file-selected": {
        if (!this.currentSession) {
          break;
        }
        this.setTranscriptFile(this.currentSession, e.path);
        this.pushLog(
          `Transcript: ${e.path.split("/").pop() || e.path}`,
          `Summarizing transcript: ${e.path}`,
          this.currentSession
        );
        break;
      }
      case "summary-file-created": {
        if (!this.currentSession) {
          break;
        }
        this.setSummaryFile(this.currentSession, e.path);
        this.pushLog(
          `Summary: ${e.path.split("/").pop() || e.path}`,
          `Summary saved to: ${e.path}`,
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
          `Step 3: Summarizing with a ${e.prompt.length}-character prompt`,
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
        // The Retry button lives in the progress area's summary section
        this.pushLog(
          "Step 2: Classification failed",
          `Step 2: Classification failed - ${e.message}`,
          this.currentSession
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
          "API request failed - show logs for more",
          `Failed: ${e.message}`,
          this.currentSession
        );
        this.finalizeSession(this.currentSession, "error", "failed");
        break;
      }
    }
  }
}
