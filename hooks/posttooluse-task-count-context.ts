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
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { buildCountSummary, buildCountSummaryFromTasks } from "../src/tasks/task-count-summary.ts"
import { getSessionEventState } from "../src/tasks/task-event-state.ts"
import { getSessionTasksDir, readSessionTasksFresh } from "../src/tasks/task-recovery.ts"
import { toolHookInputSchema } from "./schemas.ts"

export { buildCountSummary, buildCountSummaryFromTasks }

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
