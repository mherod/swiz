/**
 * Action plan generation for incomplete tasks.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"

export { formatIncompleteReason } from "../../src/tasks/task-governance-messages.ts"

export function buildIncompleteBlockOutput(taskDetails: string[]): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails)
  return blockStopObj(reason)
}
