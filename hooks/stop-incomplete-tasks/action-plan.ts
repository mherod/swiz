/**
 * Action plan generation for incomplete tasks.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"

export function formatIncompleteReason(taskDetails: string[]): string {
  if (taskDetails.length === 0) return ""

  const header = "Incomplete tasks remain in the current session:\n\n"
  const taskList = taskDetails.map((d) => `  • ${d}`).join("\n")
  const footer =
    "\n\nComplete all tasks before stopping. Use `swiz tasks` to see the full list, or `/commit` to wrap up in progress work."

  return header + taskList + footer
}

export function buildIncompleteBlockOutput(taskDetails: string[]): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails)
  return blockStopObj(reason)
}
