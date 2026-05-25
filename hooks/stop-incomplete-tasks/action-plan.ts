/**
 * Action plan generation for incomplete tasks.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import {
  formatIncompleteReason,
  type TaskReviewInstructionContext,
} from "../../src/tasks/task-governance-messages.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"

export { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"

export function buildIncompleteBlockOutput(
  taskDetails: string[],
  sourceCtx?: { tasksDir: string | null; sessionId: string } & TaskReviewInstructionContext
): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails, sourceCtx)
  return blockStopObj(reason)
}

export function buildSoleDeferralSteeringOutput(realWorks: string[]): SwizHookOutput {
  const plural = realWorks.length > 1
  const reason = [
    plural
      ? "The remaining tasks were parked under a deferral label instead of completed."
      : "The last remaining task was parked under a deferral label instead of completed.",
    "All work is to be completed in this session. There is no follow-up session.",
    plural
      ? `Do the work now:\n${realWorks.map((s) => `  • ${s}`).join("\n")}`
      : `Do the work now: ${realWorks[0] ?? ""}`,
  ].join("\n")
  return blockStopObj(reason)
}
