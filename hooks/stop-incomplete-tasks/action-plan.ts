/**
 * Action plan generation for incomplete tasks.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"

export { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"

export function buildIncompleteBlockOutput(
  taskDetails: string[],
  sourceCtx?: { tasksDir: string | null; sessionId: string }
): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails, sourceCtx)
  return blockStopObj(reason)
}

export function buildSoleDeferralSteeringOutput(realWork: string): SwizHookOutput {
  const reason = [
    "The last remaining task was parked under a deferral label instead of completed.",
    `Do the work now: ${realWork}`,
    "",
    "If this is genuinely next-session work, add a second Follow-up: or Consider task so there are two deferred items — stop is allowed when two or more deferred tasks remain.",
  ].join("\n")
  return blockStopObj(reason)
}
