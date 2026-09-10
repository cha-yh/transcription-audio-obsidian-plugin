import type { ProgressStage } from "_base/types/progress";

/** File kept next to the plugin's own data.json, not inside the vault. */
export const SESSION_HISTORY_FILE = "progress-sessions.json";

export const SESSION_HISTORY_VERSION = 1;

/**
 * Records written by a schema older than this are dropped rather than
 * migrated. Raising it lets old migration steps be deleted; the retention
 * limit is what makes that safe, since stale schemas age out on their own.
 */
export const MIN_SUPPORTED_SESSION_HISTORY_VERSION = 1;

export const DEFAULT_HISTORY_LIMIT = 20;
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 200;

/** Writes are debounced by this much; terminal stages flush immediately. */
export const SESSION_SAVE_DEBOUNCE_MS = 1000;

/** Log lines kept per session before the oldest are folded into a notice. */
export const MAX_LOG_LINES_PER_SESSION = 300;

/**
 * Above this the file is trimmed oldest-first regardless of the user's limit.
 * A stored run is a convenience, not a reason to grow the plugin folder
 * without bound when auto-removal is switched off.
 */
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** Stages that end a run, so the panel state is worth writing out at once. */
export const TERMINAL_STAGES: ProgressStage[] = ["success", "error", "cancelled"];
