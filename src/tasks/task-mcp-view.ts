/**
 * MCP task view — pure string rendering for the swiz MCP task tools.
 *
 * These tools answer an agent, not a terminal: no ANSI, no console writes
 * (stdout is the JSON-RPC stream), and every list is bounded. A project-keyed
 * store accumulates hundreds of completed tasks, so an unbounded dump of the
 * task array crowded out the answer it was meant to support — completed and
 * cancelled work is therefore counted, not listed, and open groups are capped
 * with an explicit "+N more" so the truncation is visible rather than silent.
 *
 * The board reads the `blocks`/`blockedBy` edges as a state machine rather than
 * a flat status list: pending work splits into READY and BLOCKED, in-progress
 * tasks carry the leverage they hold (how much they unblock), transitions that
 * free downstream work are announced, and states that cannot progress — a
 * dependency cycle, a task started while still blocked, an all-blocked queue —
 * are named as such, because those are exactly the states the caller cannot
 * infer from the status it just wrote.
 */

import { formatDuration } from "../format-duration.ts"
import type { Task } from "./task-repository.ts"
import { getTaskCompletedAtMs, getTaskCurrentDurationMs } from "./task-timing.ts"
import {
  countTasksFreedBy,
  findDependencyCycle,
  indexTasksById,
  isBlocked,
  openBlockersOf,
  partitionTasks,
  pickCriticalPathTask,
} from "./task-topology.ts"

export {
  countTasksFreedBy,
  findDependencyCycle,
  findNewlyUnblockedTasks,
  isOpenStatus,
  openBlockersOf,
} from "./task-topology.ts"

/** Subject text longer than this is elided; keeps one task to one line. */
export const MAX_SUBJECT_LENGTH = 72
/** Subject cap for tasks named inline within a single summary line. */
export const MAX_INLINE_SUBJECT_LENGTH = 40
/** Tasks listed per open group before the remainder collapses to a count. */
export const MAX_LISTED_PER_GROUP = 8
/** Most recently completed (or newly unblocked) tasks named on a summary line. */
export const MAX_INLINE_TASKS = 3
/** Ids shown when reporting a dependency cycle. */
export const MAX_CYCLE_IDS = 4
/** In-progress work older than this is called out as possibly abandoned. */
export const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000

export interface TaskListSummary {
  total: number
  pending: number
  inProgress: number
  completed: number
  cancelled: number
}

/**
 * Bucket every task status for the task-tool responses.
 *
 * Every status needs its own bucket. Omitting `cancelled` made the buckets sum to 47 against a
 * `total` of 48, so a consumer deriving remaining work as
 * `total - completed - pending - inProgress` counted a phantom open task. When a status is added
 * to `TASK_STATUSES`, add it here too — the exhaustiveness test in `mcp.test.ts` fails otherwise.
 */
export function summarizeTasks(tasks: readonly Task[]): TaskListSummary {
  const countByStatus = (status: Task["status"]): number =>
    tasks.filter((task) => task.status === status).length
  return {
    total: tasks.length,
    pending: countByStatus("pending"),
    inProgress: countByStatus("in_progress"),
    completed: countByStatus("completed"),
    cancelled: countByStatus("cancelled"),
  }
}

/** Collapse whitespace and elide overlong text so each task renders on one line. */
export function truncateForLine(text: string, max = MAX_SUBJECT_LENGTH): string {
  const flattened = text.replace(/\s+/g, " ").trim()
  if (flattened.length <= max) return flattened
  return `${flattened.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// ─── Lines ──────────────────────────────────────────────────────────────────

function namedTaskList(tasks: readonly Task[], limit = MAX_INLINE_TASKS): string {
  const named = tasks
    .slice(0, limit)
    .map((task) => `#${task.id} ${truncateForLine(task.subject, MAX_INLINE_SUBJECT_LENGTH)}`)
    .join(", ")
  const hidden = tasks.length - Math.min(tasks.length, limit)
  return hidden > 0 ? `${named} (+${hidden} more)` : named
}

function taskSuffix(task: Task, tasks: readonly Task[], byId: ReadonlyMap<string, Task>): string {
  const parts: string[] = []
  if (task.status === "in_progress") {
    const durationMs = getTaskCurrentDurationMs(task)
    if (durationMs > 0) parts.push(formatDuration(durationMs))
    if (durationMs >= STALE_IN_PROGRESS_MS) parts.push("stalled — finish, split, or cancel")
  }
  const blockers = openBlockersOf(task, byId)
  if (blockers.length > 0) {
    const label = task.status === "in_progress" ? "started while blocked by" : "blocked by"
    parts.push(`${label} #${blockers.join(", #")}`)
  }
  const freed = countTasksFreedBy(task, tasks, byId)
  if (freed > 0) parts.push(`unblocks ${freed}`)
  return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

/** One task as a single bounded line: `  → #id  subject (12m, unblocks 2)`. */
export function formatTaskLine(
  task: Task,
  tasks: readonly Task[] = [task],
  highlight = false
): string {
  const marker = highlight ? "→" : " "
  const suffix = taskSuffix(task, tasks, indexTasksById(tasks))
  return `  ${marker} #${task.id}  ${truncateForLine(task.subject)}${suffix}`
}

function formatGroup(
  title: string,
  group: readonly Task[],
  tasks: readonly Task[],
  highlightId: string | undefined
): string[] {
  if (group.length === 0) return []
  const shown = group.slice(0, MAX_LISTED_PER_GROUP)
  const lines = [
    `${title} (${group.length})`,
    ...shown.map((task) => formatTaskLine(task, tasks, task.id === highlightId)),
  ]
  const hidden = group.length - shown.length
  if (hidden > 0) lines.push(`    +${hidden} more ${title.toLowerCase()}`)
  return lines
}

function byCompletedAtDesc(a: Task, b: Task): number {
  return (getTaskCompletedAtMs(b) ?? 0) - (getTaskCompletedAtMs(a) ?? 0)
}

function formatCompletedLine(completed: readonly Task[]): string[] {
  if (completed.length === 0) return []
  const recent = [...completed].sort(byCompletedAtDesc)
  return [`RECENTLY COMPLETED (${completed.length})`, `    ${namedTaskList(recent)}`]
}

function formatTotals(summary: TaskListSummary, ready: number, blocked: number): string {
  const open = summary.inProgress + summary.pending
  const parts = [
    `${open} open`,
    `${summary.inProgress} in progress`,
    `${ready} ready`,
    `${blocked} blocked`,
    `${summary.completed} completed`,
  ]
  if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`)
  return `Totals: ${summary.total} task(s) — ${parts.join(", ")}`
}

/** `Unblocked: #a2 Wire the renderer, #a3 Ship it (+1 more)` — or null when nothing was freed. */
export function renderUnblockedLine(unblocked: readonly Task[]): string | null {
  if (unblocked.length === 0) return null
  return `Unblocked: ${namedTaskList(unblocked)} — ready to start.`
}

/**
 * The single most useful next instruction for the current topology, or null when the queue is
 * healthy and moving.
 *
 * The task gates block tool use at zero open tasks and at zero in-progress work, and a queue whose
 * every pending task is blocked cannot be started at all — each of those is a state the caller is
 * about to walk into, so it is named here with the move that resolves it.
 */
export function taskQueueHint(tasks: readonly Task[]): string | null {
  const byId = indexTasksById(tasks)
  const inProgress = tasks.filter((task) => task.status === "in_progress")
  const pending = tasks.filter((task) => task.status === "pending")
  const ready = pending.filter((task) => !isBlocked(task, byId))

  const cycle = findDependencyCycle(tasks)
  if (cycle) {
    const shown = cycle.slice(0, MAX_CYCLE_IDS)
    const loop = [...shown, shown[0]].map((id) => `#${id}`).join(" → ")
    return `Dependency cycle: ${loop} — nothing in this chain can start; drop one blockedBy edge.`
  }
  if (inProgress.length + pending.length === 0) {
    return "No open tasks — create the next step with TaskCreate before more work."
  }
  const next = inProgress.length === 0 ? pickCriticalPathTask(ready, tasks) : null
  if (next) {
    return `Start next: TaskUpdate #${next.id} status:"in_progress" — ${truncateForLine(next.subject, MAX_INLINE_SUBJECT_LENGTH)}.`
  }
  // With no in-progress work and no ready task, every pending task waits on another pending task,
  // which can only happen inside a cycle — already reported above.
  if (pending.length === 0) {
    return "No pending task queued — add the follow-on step before completing the last one."
  }
  if (ready.length === 0) {
    return `Every pending task is blocked — finishing #${inProgress[0]!.id} is what moves the queue.`
  }
  return null
}

/** The bounded open-work board shared by every task tool response. */
export function renderTaskBoard(tasks: readonly Task[], highlightId?: string): string {
  const summary = summarizeTasks(tasks)
  const { inProgress, ready, blocked, completed } = partitionTasks(tasks)

  const lines = [
    ...formatGroup("IN PROGRESS", inProgress, tasks, highlightId),
    ...formatGroup("READY", ready, tasks, highlightId),
    ...formatGroup("BLOCKED", blocked, tasks, highlightId),
    ...formatCompletedLine(completed),
    formatTotals(summary, ready.length, blocked.length),
  ]
  const hint = taskQueueHint(tasks)
  if (hint) lines.push(hint)
  return lines.join("\n")
}

/** A tool response: a headline confirming what changed, then the board. */
export function renderTaskToolResult(
  headline: string,
  tasks: readonly Task[],
  highlightId?: string
): string {
  return `${headline}\n\n${renderTaskBoard(tasks, highlightId)}`
}

/** Human-readable list of the fields a TaskUpdate actually changed. */
export function describeTaskChanges(
  changes: ReadonlyArray<string | null | undefined>
): string | null {
  const named = changes.filter((change): change is string => Boolean(change))
  return named.length > 0 ? named.join(", ") : null
}
