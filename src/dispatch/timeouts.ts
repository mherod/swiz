/**
 * Per-event hook execution budget (seconds), before context humanising.
 *
 * This module intentionally has no runtime imports so the hook-dispatch
 * bootstrap can read the canonical budgets without loading the manifest and
 * every hook module on the daemon-success path.
 */
export const DISPATCH_TIMEOUTS: Readonly<Record<string, number>> = {
  stop: 180,
  // Steering can spend 30s rewriting; pre-tool feedback can first spend 15s refining.
  preToolUse: 60,
  postToolUse: 45,
  postToolUseFailure: 10,
  sessionStart: 20,
  preCompact: 15,
  postCompact: 10,
  permissionRequest: 10,
  taskCreated: 10,
  taskCompleted: 10,
  userPromptSubmit: 15,
  preCommit: 30,
  commitMsg: 10,
  prePush: 30,
}

export const HOOK_CONTEXT_HUMANISE_TIMEOUT_MS = 15_000

/** Reserve the full rewrite budget in transport and installed agent deadlines. */
export function dispatchTimeoutSeconds(canonicalEvent: string): number {
  return (DISPATCH_TIMEOUTS[canonicalEvent] ?? 30) + HOOK_CONTEXT_HUMANISE_TIMEOUT_MS / 1000
}
