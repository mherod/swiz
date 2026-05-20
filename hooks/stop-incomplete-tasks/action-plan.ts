/**
 * Action plan generation for incomplete tasks.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"

export { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"

export function buildIncompleteBlockOutput(
  taskDetails: string[],
  sourceCtx?: { tasksDir: string | null; sessionId: string; taskListAvailable?: boolean }
): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails, sourceCtx)
  return blockStopObj(reason)
}

export function buildSoleDeferralSteeringOutput(realWork: string): SwizHookOutput {
  const reason = [
    "The last remaining task was parked under a deferral label instead of completed.",
    "All work is to be completed in this session. There is no follow-up session.",
    `Do the work now: ${realWork}`,
  ].join("\n")
  return blockStopObj(reason)
}
