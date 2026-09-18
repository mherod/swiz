/** Task governance configuration thresholds and intervals. */

/** Threshold (non-task calls) before hard blocking on stale tasks. */
export const TASK_STALENESS_ENFORCEMENT_THRESHOLD = 60

/**
 * Maximum age (in milliseconds) an open task's last update may reach before
 * new task creation is blocked. A queue whose open rows have gone quiet for
 * this long no longer describes the work in flight, so the next TaskCreate
 * has to reconcile the existing rows first.
 */
export const OPEN_TASK_UPDATE_RECENCY_LIMIT_MS = 10 * 60_000

/**
 * Age past which an open task stops blocking task creation. Beyond this it is no
 * longer plausibly work in flight — it is an abandoned row, or one owned by a
 * session that has moved on — and the shared project store means such a row would
 * otherwise wedge every later session's queue. The gate stops blocking on it and
 * reports it for cleanup instead.
 */
export const OPEN_TASK_ABANDONED_CEILING_MS = 60 * 60_000

/**
 * Release valve. When this many creation attempts appear in the recent tool
 * window and the gate is still denying, the gate has stopped producing progress:
 * it releases once, loudly, rather than wedging a workflow whose remedy it cannot
 * see. Sized so a normal deny → update → retry cycle never reaches it.
 */
export const OPEN_TASK_GATE_RELEASE_ATTEMPTS = 4

/** Trailing tool calls inspected when counting attempts for the release valve. */
export const OPEN_TASK_GATE_RELEASE_WINDOW = 20

/** Maximum age (in milliseconds) before canonical TaskList must be refreshed. */
export const CANONICAL_TASKLIST_SYNC_MAX_AGE_MS = 20 * 60_000

// --- Task Cache Constants ---

/** Default number of most-recent task files to re-read on incremental refresh. */
export const INCREMENTAL_FILE_LIMIT = 10

/** Time-based staleness ceiling for task state cache. */
export const DEFAULT_STALE_CEILING_MS = 5_000

/** Default max age (ms) for freshness-guaranteed reads. */
export const DEFAULT_MAX_STALE_MS = 60_000

/** Maximum cached sessions before LRU eviction. */
export const MAX_CACHED_SESSIONS = 50

/** Completed task pruning age threshold. */
export const COMPLETED_TASK_PRUNE_AGE_MS = 15 * 60_000

/**
 * Age-based pruning threshold for task records of any status. A task whose
 * last recorded activity predates this no longer reflects work anybody is
 * doing, and a stale in_progress row keeps consuming the project WIP budget
 * of sessions that never opened it.
 */
export const STALE_TASK_PRUNE_AGE_MS = 2 * 24 * 60 * 60_000
