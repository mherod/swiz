#!/usr/bin/env bun

/**
 * PostToolUse hook: Inject task count context after TaskCreate/TaskUpdate.
 *
 * Reads the session's task state (via cache when available) and emits an
 * additionalContext message with incomplete/pending/in_progress counts.
 * Warns urgently when pending tasks drop to 1 or 0, since the governance
 * system requires at least 1 pending task at all times. When the queue is
 * healthy (several pending plus an in_progress task), emits affirmative
 * feedback so the model sees both correct and negligent patterns.
 */

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { getSessionEventState } from "../src/tasks/task-event-state.ts"
import {
  getSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasksFresh,
} from "../src/tasks/task-recovery.ts"
import { buildContextHookOutput } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Minimum pending count treated as a healthy planning buffer for positive feedback. */
const PLENTY_PENDING_THRESHOLD = 2

export function buildCountSummary(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
}): string {
  const parts: string[] = [
    `Tasks: ${counts.total} total, ${counts.incomplete} incomplete (${counts.inProgress} in_progress, ${counts.pending} pending).`,
  ]

  if (counts.pending === 0) {
    parts.push(
      "URGENT: Zero pending tasks. Task governance requires ≥2 pending tasks at all times. Use TaskCreate to add two pending tasks now: (1) a verification task for the current step (e.g. run tests, check output), and (2) a broader next-step task for the natural follow-on work (e.g. hardening, integration, cleanup)."
    )
  } else if (counts.pending === 1 && counts.incomplete <= 2) {
    parts.push(
      "Proactive task planning needed: only 1 pending task remains. Create 1 more pending task to maintain the planning buffer. Aim for two pending tasks: one immediate verification step and one broader logical next task."
    )
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

/**
 * Apply the just-executed tool mutation on top of disk-read tasks.
 * Claude's native TaskCreate/TaskUpdate writes to disk asynchronously —
 * the PostToolUse hook may fire before the write lands. Overlaying the
 * mutation from tool_input ensures accurate counts.
 */
export function applyMutationOverlay(
  tasks: Array<{ id: string; status: string }>,
  toolName: string,
  toolInput: Record<string, unknown>
): Array<{ id: string; status: string }> {
  if (toolName === "TaskUpdate" || toolName === "TodoWrite") {
    const taskId = String(toolInput.taskId ?? toolInput.id ?? "")
    const newStatus = String(toolInput.status ?? "")
    if (taskId && newStatus) {
      const idx = tasks.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        tasks[idx] = { ...tasks[idx]!, status: newStatus }
      }
    }
  } else if (toolName === "TaskCreate") {
    // TaskCreate adds a new pending task — if disk read missed it, add a placeholder
    const subject = String(toolInput.subject ?? "")
    if (subject && !tasks.some((t) => t.status === "pending")) {
      tasks.push({ id: "new", status: "pending" })
    }
  }
  return tasks
}

export async function evaluatePosttooluseTaskCountContext(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const sessionId = resolveSafeSessionId(parsed.session_id)
  if (!sessionId) return {}

  // Primary path: in-memory event state maintained by upstream hooks
  // (audit-sync, list-sync) in the same dispatch process. Zero disk I/O.
  const eventState = getSessionEventState(sessionId)
  if (eventState && eventState.length > 0) {
    return buildContextHookOutput("PostToolUse", buildCountSummaryFromTasks(eventState))
  }

  // Fallback: disk read + mutation overlay for subprocess execution
  // (when no event state exists, e.g. first tool call or standalone mode)
  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return {}

  const diskTasks = await readSessionTasksFresh(sessionId)
  if (diskTasks.length === 0 && parsed.tool_name !== "TaskCreate") return {}

  const toolInput = (parsed.tool_input ?? {}) as Record<string, unknown>
  const tasks = applyMutationOverlay(
    diskTasks.map((t) => ({ id: t.id, status: t.status })),
    parsed.tool_name ?? "",
    toolInput
  )

  if (tasks.length === 0) return {}

  return buildContextHookOutput("PostToolUse", buildCountSummaryFromTasks(tasks))
}

function buildCountSummaryFromTasks(tasks: Array<{ id: string; status: string }>): string {
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
  return buildCountSummary({
    total: tasks.length,
    incomplete,
    pending,
    inProgress,
  })
}

const posttooluseTaskCountContext: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-count-context",
  event: "postToolUse",
  matcher: "TaskUpdate|TaskCreate|TodoWrite",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskCountContext(input)
  },
}

export default posttooluseTaskCountContext

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskCountContext)
}
