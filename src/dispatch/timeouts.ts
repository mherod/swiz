/**
 * Per-event hook execution budget (seconds), before context humanising.
 *
 * This module intentionally has no runtime imports so the hook-dispatch
 * bootstrap can read the canonical budgets without loading the manifest and
 * every hook module on the daemon-success path.
 */
/**
 * One budget for every event: the 5s per-hook cap plus the 3s SIGTERM→SIGKILL
 * grace (`HOOK_TIMEOUT_CAP_SEC` + `SIGKILL_GRACE_MS` in worker-types.ts). Hooks
 * run concurrently, so nothing can usefully take longer. The dispatch client
 * enforces this from its own process, which a busy daemon thread cannot delay,
 * and on expiry the daemon aborts the dispatch and kills its hook processes.
 */
export const DISPATCH_BUDGET_SEC = 8

export const DISPATCH_TIMEOUTS: Readonly<Record<string, number>> = {
  stop: DISPATCH_BUDGET_SEC,
  preToolUse: DISPATCH_BUDGET_SEC,
  postToolUse: DISPATCH_BUDGET_SEC,
  postToolUseFailure: DISPATCH_BUDGET_SEC,
  sessionStart: DISPATCH_BUDGET_SEC,
  preCompact: DISPATCH_BUDGET_SEC,
  postCompact: DISPATCH_BUDGET_SEC,
  permissionRequest: DISPATCH_BUDGET_SEC,
  taskCreated: DISPATCH_BUDGET_SEC,
  taskCompleted: DISPATCH_BUDGET_SEC,
  userPromptSubmit: DISPATCH_BUDGET_SEC,
  preCommit: DISPATCH_BUDGET_SEC,
  commitMsg: DISPATCH_BUDGET_SEC,
  prePush: DISPATCH_BUDGET_SEC,
}

export const HOOK_CONTEXT_HUMANISE_TIMEOUT_MS = 15_000

/** Reserve the full rewrite budget in transport and installed agent deadlines. */
export function dispatchTimeoutSeconds(canonicalEvent: string): number {
  return (
    (DISPATCH_TIMEOUTS[canonicalEvent] ?? DISPATCH_BUDGET_SEC) +
    HOOK_CONTEXT_HUMANISE_TIMEOUT_MS / 1000
  )
}
