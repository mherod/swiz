#!/usr/bin/env bun

/**
 * PostToolUse hook: Inject task count context after TaskCreate/TaskUpdate.
 *
 * Reads the session's task state (via cache when available) and emits an
 * additionalContext message with compact task-state guidance.
 * Warns urgently when pending tasks drop to 1 or 0, since the governance
 * system requires at least 1 pending task at all times. When the queue is
 * healthy (several pending plus an in_progress task), emits affirmative
 * feedback so the model sees both correct and negligent patterns.
 */

import { agentHasTaskToolsForHookPayload } from "../src/agent-paths.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { hasHealthyTaskBuffer } from "../src/tasks/task-buffer-health.ts"
import {
  recordComplianceState,
  type TaskActivityDuration,
} from "../src/tasks/task-compliance-history.ts"
import { buildCountSummary, buildCountSummaryFromTasks } from "../src/tasks/task-count-summary.ts"
import { getSessionEventState } from "../src/tasks/task-event-state.ts"
import { fetchIssueHints } from "../src/tasks/task-issue-hints.ts"
import { getSessionTasksDir, readSessionTasksFresh } from "../src/tasks/task-recovery.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"

type TimedTask = {
  id: string
  status: string
  startedAt?: number | null
  elapsedMs?: number | null
  statusChangedAt?: string | null
}

function recordComplianceFromTasks(
  sessionId: string,
  tasks: ReadonlyArray<{ id: string; status: string }>,
  timedTasks?: ReadonlyArray<TimedTask>
): Promise<boolean> {
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
    }
  }
  const taskDurations: TaskActivityDuration[] | undefined = timedTasks
    ?.filter((t) => t.status === "in_progress" || t.status === "pending")
    .map((t) => ({
      id: t.id,
      status: t.status,
      durationMs: getTaskCurrentDurationMs(t),
    }))
  return recordComplianceState(sessionId, { pending, inProgress, incomplete }, taskDurations)
}

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
  const raw = typeof input === "object" && input !== null ? (input as Record<string, any>) : {}
  if (!agentHasTaskToolsForHookPayload(raw)) return {}
  const parsed = toolHookInputSchema.parse(input)
  const sessionId = resolveSafeSessionId(parsed.session_id)
  if (!sessionId) return {}

  // Fetch issue hints in parallel with task state resolution.
  // Only used when pending count is low, but start early to avoid latency.
  const hintsPromise = fetchIssueHints(parsed.cwd)

  // Primary path: in-memory event state maintained by upstream hooks
  // (audit-sync, list-sync) in the same dispatch process. Zero disk I/O.
  const eventState = getSessionEventState(sessionId)
  if (eventState && eventState.length > 0) {
    const hints = await hintsPromise
    recordComplianceFromTasks(sessionId, eventState).catch(() => {})
    if (parsed.tool_name === "TaskUpdate" && hasHealthyTaskBuffer(eventState)) {
      return {}
    }
    return buildContextHookOutput("PostToolUse", buildCountSummaryFromTasks(eventState, hints))
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

  const hints = await hintsPromise
  recordComplianceFromTasks(sessionId, tasks, diskTasks).catch(() => {})
  if (parsed.tool_name === "TaskUpdate" && hasHealthyTaskBuffer(tasks)) {
    return {}
  }
  return buildContextHookOutput("PostToolUse", buildCountSummaryFromTasks(tasks, hints))
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
