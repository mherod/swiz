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

type TaskState = { id: string; status: string }

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
  tasks: TaskState[],
  toolName: string,
  toolInput: Record<string, unknown>
): TaskState[] {
  if (toolName === "TaskUpdate" || toolName === "TodoWrite") {
    applyTaskUpdateOverlay(tasks, toolInput)
  } else if (toolName === "TaskCreate") {
    applyTaskCreateOverlay(tasks, toolInput)
  }
  return tasks
}

function applyTaskUpdateOverlay(tasks: TaskState[], toolInput: Record<string, unknown>): void {
  const taskId = String(toolInput.taskId ?? toolInput.id ?? "")
  const newStatus = String(toolInput.status ?? "")
  if (!taskId || !newStatus) return

  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) return
  tasks[index] = { ...tasks[index]!, status: newStatus }
}

function applyTaskCreateOverlay(tasks: TaskState[], toolInput: Record<string, unknown>): void {
  // TaskCreate adds a new pending task — if disk read missed it, add a placeholder
  const subject = String(toolInput.subject ?? "")
  if (!subject || tasks.some((task) => task.status === "pending")) return
  tasks.push({ id: "new", status: "pending" })
}

interface BuildTaskContextOptions {
  sessionId: string
  tasks: ReadonlyArray<TaskState>
  timedTasks?: ReadonlyArray<TimedTask>
  toolName: string | undefined
  hintsPromise: ReturnType<typeof fetchIssueHints>
}

async function buildTaskContext(options: BuildTaskContextOptions): Promise<SwizHookOutput> {
  const hints = await options.hintsPromise
  recordComplianceFromTasks(options.sessionId, options.tasks, options.timedTasks).catch(() => {})
  if (options.toolName === "TaskUpdate" && hasHealthyTaskBuffer(options.tasks)) return {}
  return buildContextHookOutput("PostToolUse", buildCountSummaryFromTasks(options.tasks, hints))
}

async function evaluateEventStateContext(
  sessionId: string,
  toolName: string | undefined,
  hintsPromise: ReturnType<typeof fetchIssueHints>
): Promise<SwizHookOutput | null> {
  const eventState = getSessionEventState(sessionId)
  if (!eventState || eventState.length === 0) return null
  return await buildTaskContext({ sessionId, tasks: eventState, toolName, hintsPromise })
}

async function evaluateDiskTaskContext(
  sessionId: string,
  toolName: string | undefined,
  toolInput: Record<string, unknown>,
  hintsPromise: ReturnType<typeof fetchIssueHints>
): Promise<SwizHookOutput> {
  if (!getSessionTasksDir(sessionId)) return {}

  const diskTasks = await readSessionTasksFresh(sessionId)
  if (diskTasks.length === 0 && toolName !== "TaskCreate") return {}

  const tasks = applyMutationOverlay(
    diskTasks.map((task) => ({ id: task.id, status: task.status })),
    toolName ?? "",
    toolInput
  )
  if (tasks.length === 0) return {}

  return await buildTaskContext({
    sessionId,
    tasks,
    timedTasks: diskTasks,
    toolName,
    hintsPromise,
  })
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
  const eventStateContext = await evaluateEventStateContext(
    sessionId,
    parsed.tool_name,
    hintsPromise
  )
  if (eventStateContext) return eventStateContext

  // Fallback: disk read + mutation overlay for subprocess execution
  // (when no event state exists, e.g. first tool call or standalone mode)
  return await evaluateDiskTaskContext(
    sessionId,
    parsed.tool_name,
    (parsed.tool_input ?? {}) as Record<string, unknown>,
    hintsPromise
  )
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
