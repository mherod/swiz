/**
 * Task count summary builder — shared by PostToolUse hooks that inject
 * task hygiene feedback (count-context and list-sync).
 *
 * Extracted from hooks/posttooluse-task-count-context.ts so both hooks
 * and src/ modules can import without cross-hook dependencies.
 */

import { isIncompleteTaskStatus } from "./task-recovery.ts"

/** Minimum pending count treated as a healthy planning buffer for positive feedback. */
const PLENTY_PENDING_THRESHOLD = 2

export function buildCountSummary(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
  issueHints?: string[]
}): string {
  const parts: string[] = [`Tasks: ${counts.inProgress} in_progress, ${counts.pending} pending.`]

  const needsPlanning = counts.pending === 0 || (counts.pending === 1 && counts.incomplete <= 2)

  if (counts.pending === 0) {
    parts.push(
      "URGENT: Zero pending tasks. Task governance requires ≥2 pending tasks at all times. Use TaskCreate to add two pending tasks now: (1) a verification task for the current step (e.g. run tests, check output), and (2) a broader next-step task for the natural follow-on work (e.g. hardening, integration, cleanup)."
    )
  } else if (counts.pending === 1 && counts.incomplete <= 2) {
    parts.push(
      "Proactive task planning needed: only 1 pending task remains. Create 1 more pending task to maintain the planning buffer. Aim for two pending tasks: one immediate verification step and one broader logical next task."
    )
  }

  if (needsPlanning && counts.issueHints && counts.issueHints.length > 0) {
    parts.push(`Open issues you could plan for: ${counts.issueHints.join("; ")}.`)
  }

  if (counts.inProgress === 0 && counts.incomplete > 0) {
    parts.push(
      "No in_progress task. Transition a pending task to in_progress before starting implementation."
    )
  } else if (counts.pending >= PLENTY_PENDING_THRESHOLD && counts.inProgress >= 1) {
    parts.push(
      "Good task hygiene: you have a planning buffer (multiple pending tasks) and a single clear in_progress focus. That matches workflow expectations—keep updating status as you complete work and add pending tasks before the queue runs low."
    )
  }

  return parts.join(" ")
}

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
