/**
 * Per-event timeout budget for daemon-backed dispatch requests (seconds).
 *
 * This module intentionally has no runtime imports so the hook-dispatch
 * bootstrap can read the canonical budgets without loading the manifest and
 * every hook module on the daemon-success path.
 */
export const DISPATCH_TIMEOUTS: Readonly<Record<string, number>> = {
  stop: 180,
  preToolUse: 15,
  postToolUse: 15,
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
