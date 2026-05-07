/**
 * Task count summary builder — shared by PostToolUse hooks that inject
 * task hygiene feedback (count-context and list-sync).
 */

import { buildCountSummary } from "./task-governance-messages.ts"
import { isIncompleteTaskStatus } from "./task-recovery.ts"

export { buildCountSummary } from "./task-governance-messages.ts"

export function buildCountSummaryFromTasks(
  tasks: ReadonlyArray<{ id: string; status: string }>,
  issueHints?: string[]
): string {
  let pending = 0
  let inProgress = 0
  let incomplete = 0
  for (const t of tasks) {
    if (t.status === "pending") {
      pending++
      incomplete++
    } else if (t.status === "in_progress") {
      inProgress++
      incomplete++
    } else if (isIncompleteTaskStatus(t.status)) {
      incomplete++
    }
  }
  return buildCountSummary({ total: tasks.length, incomplete, pending, inProgress, issueHints })
}
