import {
  MAX_HISTORY_BYTES,
  SESSION_SAVE_DEBOUNCE_MS,
} from "_base/constants/sessionHistory";
import type { PersistedSession } from "_base/types/sessionHistory";
import {
  createDebouncedRunner,
  type DebouncedRunner,
} from "_base/utils/debounce";
import {
  createHistoryDoc,
  demoteRunning,
  parseSessionHistory,
  pruneSessions,
  staleRetries,
} from "_base/utils/sessionSnapshot";

/**
 * File access, injected rather than taken from Obsidian directly. Keeping the
 * store free of `obsidian` imports is what lets its tests run in the Node
 * environment this repo uses, with a plain object standing in for the vault.
 */
export interface SessionHistoryPort {
  /** Null when no history file exists yet. */
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
  /** Move the existing file aside under `<name>.<label>.bak.json`. */
  backup(label: string): Promise<void>;
}

export interface SessionHistoryOptions {
  enabled: boolean;
  /** Undefined keeps every record — auto-removal switched off. */
  limit: number | undefined;
}

/**
 * UTF-8 size, not string length: a Korean path or error message is three bytes
 * per character, so comparing `length` against a byte budget would let the
 * file grow to roughly three times the cap.
 */
function byteLength(data: string): number {
  return new TextEncoder().encode(data).length;
}

/**
 * Owns the on-disk copy of the progress panel's runs.
 *
 * Writes are debounced and chained: a run emits progress events far faster
 * than a file should be rewritten, and two overlapping writes to one path
 * interleave badly.
 */
export class ProgressHistoryStore {
  private sessions: PersistedSession[] = [];
  private source: (() => PersistedSession[]) | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly runner: DebouncedRunner;
  private enabled: boolean;
  private limit: number | undefined;

  constructor(
    private readonly port: SessionHistoryPort,
    options: SessionHistoryOptions,
    debounceMs: number = SESSION_SAVE_DEBOUNCE_MS
  ) {
    this.enabled = options.enabled;
    this.limit = options.limit;
    this.runner = createDebouncedRunner(() => {
      void this.persist();
    }, debounceMs);
  }

  /**
   * Reads the file once per plugin load and demotes anything still marked as
   * running — such a run did not survive the unload that preceded this one.
   *
   * Deliberately not called when the view opens: reopening the sidebar while
   * the plugin is alive must keep the live in-memory session, not replace it
   * with a stale snapshot.
   */
  async hydrate(): Promise<void> {
    this.sessions = [];
    if (!this.enabled) return;

    let raw: string | null;
    try {
      raw = await this.port.read();
    } catch (e) {
      console.error("[sessionHistory] could not read history", e);
      return;
    }
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("[sessionHistory] history file is not valid JSON", e);
      // Starting empty means the next write replaces this file, so keep a
      // copy first: unreadable here is not unrecoverable by hand.
      await this.backupAside("unreadable");
      return;
    }

    const { sessions, futureVersion } = parseSessionHistory(parsed);
    if (futureVersion !== undefined) {
      // Written by a newer plugin. Overwriting it would destroy records this
      // version cannot read, so set it aside and start empty instead.
      await this.backupAside(`v${futureVersion}`);
      return;
    }
    if (sessions.length === 0 && this.hasStoredSessions(parsed)) {
      // The file held records but none of them survived parsing — a schema too
      // old to migrate, or damage. Same reasoning as above.
      await this.backupAside("unreadable");
      return;
    }

    this.sessions = pruneSessions(
      staleRetries(demoteRunning(sessions)),
      this.limit
    );
  }

  private hasStoredSessions(parsed: unknown): boolean {
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { sessions?: unknown }).sessions) &&
      (parsed as { sessions: unknown[] }).sessions.length > 0
    );
  }

  private async backupAside(label: string): Promise<void> {
    try {
      await this.port.backup(label);
    } catch (e) {
      console.error("[sessionHistory] could not back up history", e);
    }
  }

  /** Restored records, newest first. */
  list(): PersistedSession[] {
    return this.sessions;
  }

  /**
   * The view hands over a getter instead of a snapshot so the list is only
   * built when a write actually happens, not on every progress event.
   */
  setSource(source: () => PersistedSession[]): void {
    this.source = source;
  }

  /**
   * Keeps the last known list so closing the view does not blank the file.
   *
   * Takes the source back so a closing panel cannot detach a different one:
   * with two panel leaves open, Obsidian creates the new view before tearing
   * the old one down, and an unconditional clear would freeze the surviving
   * panel's history at that moment.
   */
  clearSource(source: () => PersistedSession[]): void {
    if (this.source !== source) return;
    this.sessions = this.source();
    this.source = null;
  }

  setOptions(options: SessionHistoryOptions): void {
    this.enabled = options.enabled;
    this.limit = options.limit;
    if (!this.enabled) {
      // Nothing further is written, and the existing file is left untouched.
      this.runner.cancel();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLimit(): number | undefined {
    return this.limit;
  }

  schedule(): void {
    if (!this.enabled) return;
    this.runner.schedule();
  }

  /** Writes now — for a finished run, a deletion, or teardown. */
  flush(): Promise<void> {
    this.runner.cancel();
    return this.persist();
  }

  dispose(): void {
    this.runner.cancel();
    void this.persist();
    this.source = null;
  }

  private persist(): Promise<void> {
    if (!this.enabled) return Promise.resolve();

    const collected = this.source ? this.source() : this.sessions;
    const { kept, data } = this.serialize(collected);
    // What was written is what the store holds; otherwise list() hands the
    // panel records that are not in the file and vanish on the next reload.
    this.sessions = kept;

    this.writeChain = this.writeChain
      .then(() => this.port.write(data))
      .catch((e) => {
        // A failed write must not poison the chain, or every later save fails.
        console.error("[sessionHistory] could not write history", e);
      });
    return this.writeChain;
  }

  /**
   * Applies the retention limit, then drops oldest-first until the file fits.
   * The byte cap is a backstop for auto-removal being switched off; a single
   * session is never dropped, however large it is.
   */
  private serialize(sessions: PersistedSession[]): {
    kept: PersistedSession[];
    data: string;
  } {
    const limited = pruneSessions(sessions, this.limit);
    let data = JSON.stringify(createHistoryDoc(limited));
    if (byteLength(data) <= MAX_HISTORY_BYTES) return { kept: limited, data };

    // Measured per session rather than by re-serializing the whole document
    // once per dropped record, which is quadratic in the overflow.
    const overhead = byteLength(JSON.stringify(createHistoryDoc([])));
    let used = overhead;
    let fits = 0;
    for (const session of limited) {
      // +1 for the comma the array separator adds after the first entry.
      const cost = byteLength(JSON.stringify(session)) + (fits > 0 ? 1 : 0);
      if (fits > 0 && used + cost > MAX_HISTORY_BYTES) break;
      used += cost;
      fits++;
    }

    const kept = limited.slice(0, Math.max(1, fits));
    data = JSON.stringify(createHistoryDoc(kept));
    console.warn(
      `[sessionHistory] history exceeded ${MAX_HISTORY_BYTES} bytes; kept the newest ${kept.length}`
    );
    return { kept, data };
  }
}
