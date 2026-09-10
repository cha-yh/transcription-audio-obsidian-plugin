import {
  MAX_LOG_LINES_PER_SESSION,
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  MIN_SUPPORTED_SESSION_HISTORY_VERSION,
  SESSION_HISTORY_VERSION,
} from "_base/constants/sessionHistory";
import type {
  PersistedLogEntry,
  PersistedSession,
  PersistedSparkline,
  PersistedSparklineChunk,
  SessionHistoryDoc,
  SessionStatus,
} from "_base/types/sessionHistory";
import { formatLocaleDateTime } from "./format";

/**
 * The runtime shape the progress view holds. Same fields as the persisted
 * record apart from the two collections, which are Sets while a run is live
 * and arrays once written out.
 */
export interface RuntimeLogEntry extends PersistedLogEntry {
  /** A newer result for the same chunk arrived; this button is dead. */
  retryStale?: boolean;
  retryRunning?: boolean;
}

export interface SessionRuntimeState
  extends Omit<PersistedSession, "logHistory" | "failedChunks" | "chunk"> {
  logHistory: RuntimeLogEntry[];
  failedChunks: Set<number>;
  pendingRetryChunks: Set<number>;
  /**
   * Chunk progress is flat while running and folded into one object on disk.
   * `chunkLabelText` doubles as "the chunk UI exists" — it is set the first
   * time a chunk reports in, and the panel has no chunk row before that.
   */
  chunkTotal: number;
  chunkIndex: number;
  chunksCompleted: number;
  chunkBarMax: number;
  chunkBarValue: number;
  chunkLabelText?: string;
}

/**
 * Steps keyed by the version they upgrade *from*. Empty at v1 — the entry
 * exists so the first schema change has an obvious place to land.
 */
export const MIGRATIONS: Record<
  number,
  (doc: Record<string, unknown>) => Record<string, unknown>
> = {};

export interface ParsedSessionHistory {
  sessions: PersistedSession[];
  /**
   * Set when the file was written by a newer plugin than this one. The caller
   * must back the file up rather than overwrite it — otherwise running an old
   * version once destroys records the new version wrote.
   */
  futureVersion?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const STATUSES: SessionStatus[] = [
  "running",
  "interrupted",
  "success",
  "error",
  "cancelled",
];

/**
 * An unrecognised status becomes "interrupted" rather than being rejected, so
 * a value added by a newer version degrades to "this run is not going to
 * finish" instead of dropping the whole record.
 */
function asStatus(value: unknown): SessionStatus {
  return STATUSES.indexOf(value as SessionStatus) >= 0
    ? (value as SessionStatus)
    : "interrupted";
}

/**
 * A run still in progress cannot be removed: its card carries the only cancel
 * button, and dropping the record would leave the work running with nothing
 * reporting it. Used for both hiding the button and refusing the click, since
 * CSS alone still leaves the button reachable by keyboard.
 */
export function isRemovableStatus(status: SessionStatus): boolean {
  return status !== "running";
}

export function createSessionId(startedAtMs: number, seq: number): string {
  return `${startedAtMs.toString(36)}-${seq.toString(36)}`;
}

/** A brand-new run, before any progress event has landed on it. */
export function createInitialSession(
  startedAtMs: number,
  seq: number
): PersistedSession {
  return {
    id: createSessionId(startedAtMs, seq),
    startedAtMs,
    status: "running",
    statusText: "Idle",
    latestLogText: "Log start",
    fileSizeText: "-",
    modelText: "-",
    cancelLabel: "cancel",
    isCancellable: true,
    isLogExpanded: false,
    logHistory: [
      { text: `Log start: ${formatLocaleDateTime(new Date(startedAtMs))}` },
    ],
    failedChunks: [],
  };
}

/** Halves the stored size of a sparkline without changing how it reads. */
export function roundBuckets(buckets: number[]): number[] {
  return buckets.map((value) => Math.round(value * 1000) / 1000);
}

/**
 * Keeps a session's log bounded. The oldest lines go first, replaced by one
 * line saying how many were dropped so the remaining numbering still makes
 * sense to whoever reads it later.
 */
export function trimLogHistory(
  entries: PersistedLogEntry[],
  max: number = MAX_LOG_LINES_PER_SESSION
): PersistedLogEntry[] {
  if (entries.length <= max) return entries;
  const dropped = entries.length - max + 1;
  return [
    { text: `... ${dropped} earlier log lines trimmed` },
    ...entries.slice(dropped),
  ];
}

function snapshotSparkline(sparkline: PersistedSparkline): PersistedSparkline {
  return {
    buckets: roundBuckets(sparkline.buckets),
    totalMs: sparkline.totalMs,
    chunks: sparkline.chunks.map((chunk) => ({ ...chunk })),
  };
}

/**
 * Runtime state to disk record. Written as an explicit literal so that a DOM
 * reference added to the runtime type later fails to compile here rather than
 * silently ending up in the file.
 */
export function toSnapshot(state: SessionRuntimeState): PersistedSession {
  const snapshot: PersistedSession = {
    id: state.id,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    status: state.status,
    statusText: state.statusText,
    latestLogText: state.latestLogText,
    fileSizeText: state.fileSizeText,
    modelText: state.modelText,
    cancelLabel: state.cancelLabel,
    categoryText: state.categoryText,
    transcriptPath: state.transcriptPath,
    audioPath: state.audioPath,
    audioName: state.audioName,
    targetPath: state.targetPath,
    targetLine: state.targetLine,
    targetCh: state.targetCh,
    isCancellable: state.isCancellable,
    isLogExpanded: state.isLogExpanded,
    rerunDisabled: state.rerunDisabled,
    chunk:
      state.chunkLabelText === undefined
        ? undefined
        : {
            total: state.chunkTotal,
            index: state.chunkIndex,
            completed: state.chunksCompleted,
            barMax: state.chunkBarMax,
            barValue: state.chunkBarValue,
            labelText: state.chunkLabelText,
          },
    logHistory: trimLogHistory(
      state.logHistory.map((entry) => ({
        text: entry.text,
        retryChunkIndex: entry.retryChunkIndex,
        retryStale: entry.retryStale,
        sparkline: entry.sparkline
          ? snapshotSparkline(entry.sparkline)
          : undefined,
      }))
    ),
    failedChunks: Array.from(state.failedChunks).sort((a, b) => a - b),
  };
  return snapshot;
}

/**
 * Disk record back to runtime state, staleness included as stored.
 *
 * Deliberately not forcing every retry button dead here: this also runs when
 * the sidebar is reopened while the plugin is still loaded, and that run's
 * rerun context is still in the controller. Killing the buttons belongs to
 * `staleRetries`, which the store applies at the reload boundary.
 */
export function fromSnapshot(snapshot: PersistedSession): SessionRuntimeState {
  const { chunk, ...rest } = snapshot;
  return {
    ...rest,
    logHistory: snapshot.logHistory.map((entry) => ({
      ...entry,
      retryRunning: false,
    })),
    failedChunks: new Set(snapshot.failedChunks),
    pendingRetryChunks: new Set<number>(),
    chunkTotal: chunk?.total ?? 0,
    chunkIndex: chunk?.index ?? 0,
    chunksCompleted: chunk?.completed ?? 0,
    chunkBarMax: chunk?.barMax ?? 1,
    chunkBarValue: chunk?.barValue ?? 0,
    chunkLabelText: chunk?.labelText,
  };
}

function parseSparklineChunk(value: unknown): PersistedSparklineChunk | null {
  if (!isRecord(value)) return null;
  const startMs = asOptionalNumber(value.startMs);
  const endMs = asOptionalNumber(value.endMs);
  if (startMs === undefined || endMs === undefined) return null;
  return {
    chunkIndex: asNumber(value.chunkIndex, 0),
    startMs,
    endMs,
    speechRatio: asNumber(value.speechRatio, 0),
    skipped: asBoolean(value.skipped, false),
  };
}

function parseSparkline(value: unknown): PersistedSparkline | undefined {
  if (!isRecord(value) || !Array.isArray(value.buckets)) return undefined;
  const buckets = value.buckets.filter(
    (bucket): bucket is number =>
      typeof bucket === "number" && Number.isFinite(bucket)
  );
  const rawChunks = Array.isArray(value.chunks) ? value.chunks : [];
  const chunks: PersistedSparklineChunk[] = [];
  for (const rawChunk of rawChunks) {
    const chunk = parseSparklineChunk(rawChunk);
    if (chunk) chunks.push(chunk);
  }
  return { buckets, totalMs: asNumber(value.totalMs, 0), chunks };
}

function parseLogEntry(value: unknown): PersistedLogEntry | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return {
    text: value.text,
    retryChunkIndex: asOptionalNumber(value.retryChunkIndex),
    retryStale: typeof value.retryStale === "boolean" ? value.retryStale : undefined,
    sparkline: parseSparkline(value.sparkline),
  };
}

function parseChunk(value: unknown): PersistedSession["chunk"] {
  if (!isRecord(value)) return undefined;
  return {
    total: asNumber(value.total, 0),
    index: asNumber(value.index, 0),
    completed: asNumber(value.completed, 0),
    barMax: asNumber(value.barMax, 1),
    barValue: asNumber(value.barValue, 0),
    labelText: asString(value.labelText, "Chunk: -"),
  };
}

/** Returns null for a record too damaged to render; the caller drops just it. */
function parseSession(value: unknown): PersistedSession | null {
  if (!isRecord(value)) return null;
  const startedAtMs = asOptionalNumber(value.startedAtMs);
  if (startedAtMs === undefined) return null;
  if (!Array.isArray(value.logHistory)) return null;

  const logHistory: PersistedLogEntry[] = [];
  for (const rawEntry of value.logHistory) {
    const entry = parseLogEntry(rawEntry);
    if (entry) logHistory.push(entry);
  }

  const failedChunks = (
    Array.isArray(value.failedChunks) ? value.failedChunks : []
  ).filter(
    (chunk): chunk is number =>
      typeof chunk === "number" && Number.isFinite(chunk)
  );

  return {
    id: asString(value.id, createSessionId(startedAtMs, 0)),
    startedAtMs,
    endedAtMs: asOptionalNumber(value.endedAtMs),
    status: asStatus(value.status),
    statusText: asString(value.statusText, "Unknown"),
    latestLogText: asString(value.latestLogText, ""),
    fileSizeText: asString(value.fileSizeText, "-"),
    modelText: asString(value.modelText, "-"),
    cancelLabel: asString(value.cancelLabel, "done"),
    categoryText: asOptionalString(value.categoryText),
    transcriptPath: asOptionalString(value.transcriptPath),
    audioPath: asOptionalString(value.audioPath),
    audioName: asOptionalString(value.audioName),
    targetPath: asOptionalString(value.targetPath),
    targetLine: asOptionalNumber(value.targetLine),
    targetCh: asOptionalNumber(value.targetCh),
    isCancellable: asBoolean(value.isCancellable, false),
    isLogExpanded: asBoolean(value.isLogExpanded, false),
    rerunDisabled: asBoolean(value.rerunDisabled, true),
    chunk: parseChunk(value.chunk),
    logHistory,
    failedChunks,
  };
}

/**
 * Reads whatever is on disk. Sessions are validated one at a time so a single
 * damaged record costs one record, not the whole history.
 */
export function parseSessionHistory(raw: unknown): ParsedSessionHistory {
  if (!isRecord(raw)) return { sessions: [] };

  const version = asNumber(raw.version, 0);
  if (version > SESSION_HISTORY_VERSION) {
    return { sessions: [], futureVersion: version };
  }
  if (version < MIN_SUPPORTED_SESSION_HISTORY_VERSION) {
    return { sessions: [] };
  }

  let doc: Record<string, unknown> = raw;
  for (let from = version; from < SESSION_HISTORY_VERSION; from++) {
    const step = MIGRATIONS[from];
    if (!step) return { sessions: [] };
    doc = step(doc);
  }

  const rawSessions = Array.isArray(doc.sessions) ? doc.sessions : [];
  const sessions: PersistedSession[] = [];
  for (const rawSession of rawSessions) {
    try {
      const session = parseSession(rawSession);
      if (session) sessions.push(session);
    } catch (e) {
      console.error("[sessionHistory] skipping unreadable session", e);
    }
  }
  return { sessions };
}

export function createHistoryDoc(sessions: PersistedSession[]): SessionHistoryDoc {
  return { version: SESSION_HISTORY_VERSION, sessions };
}

/**
 * A run that was still going when the plugin unloaded did not survive it.
 * Saying "running" after a reload would promise progress that will never come.
 */
export function demoteRunning(sessions: PersistedSession[]): PersistedSession[] {
  return sessions.map((session) =>
    session.status === "running"
      ? {
          ...session,
          status: "interrupted" as SessionStatus,
          statusText: "Interrupted",
          latestLogText: "Interrupted by plugin reload",
          isCancellable: false,
          cancelLabel: "stopped",
        }
      : session
  );
}

/**
 * Kills every re-run affordance on a record. The context a chunk re-run needs
 * lives only in the controller's memory and holds the API key, so it never
 * survives a reload: a button restored as live would publish an event that
 * another run's context would serve, rewriting the wrong transcript.
 */
export function staleRetries(sessions: PersistedSession[]): PersistedSession[] {
  return sessions.map((session) => ({
    ...session,
    rerunDisabled: true,
    logHistory: session.logHistory.map((entry) =>
      entry.retryChunkIndex === undefined
        ? entry
        : { ...entry, retryStale: true }
    ),
  }));
}

/**
 * Newest-first list capped at `limit`. `undefined` keeps everything, which is
 * what auto-removal being switched off means.
 */
export function pruneSessions<T>(
  sessions: T[],
  limit: number | undefined
): T[] {
  if (limit === undefined) return sessions;
  return sessions.slice(0, Math.max(MIN_HISTORY_LIMIT, limit));
}

/**
 * The effective cap. A live run always occupies slot 0, so the floor of 1 is
 * what keeps it from pruning itself away.
 *
 * Independent of whether history is kept: switching that off stops writing,
 * it does not stop the panel from tidying up after itself.
 */
export function resolveHistoryLimit(settings: {
  autoPruneSessionHistory: boolean;
  sessionHistoryLimit: number;
}): number | undefined {
  if (!settings.autoPruneSessionHistory) return undefined;
  return Math.max(MIN_HISTORY_LIMIT, Math.floor(settings.sessionHistoryLimit));
}

/** Returns undefined for input not worth saving yet, e.g. a cleared field. */
export function clampHistoryLimit(raw: string | number): number | undefined {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  const truncated = Math.trunc(parsed);
  if (truncated < MIN_HISTORY_LIMIT) return MIN_HISTORY_LIMIT;
  if (truncated > MAX_HISTORY_LIMIT) return MAX_HISTORY_LIMIT;
  return truncated;
}
