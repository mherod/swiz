/** Task governance configuration thresholds and intervals. */

/** Threshold (non-task calls) before advising to create tasks. */
export const TASK_CREATION_ADVISORY_THRESHOLD = 10

/** Threshold (non-task calls) before advising task state is getting stale. */
export const TASK_STALENESS_ADVISORY_THRESHOLD = 20

/** Threshold (non-task calls) before hard blocking on stale tasks. */
export const TASK_STALENESS_ENFORCEMENT_THRESHOLD = 60

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
