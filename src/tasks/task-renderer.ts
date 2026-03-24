/**
 * Task rendering layer — terminal formatting and display.
 * Owns: DateFormat, formatDate, timeAgo, renderTask, listTasks, listAllSessionsTasks.
 */

import { format, formatDistanceToNow } from "date-fns"
import { BOLD, DIM, RESET, YELLOW } from "../ansi.ts"
import { formatDuration } from "../format-duration.ts"
import { readTasks, STATUS_STYLE, type Task } from "./task-repository.ts"
import { getOrphanSessionIds, getSessions } from "./task-resolver.ts"
import { getTaskCompletedAtMs, getTaskCurrentDurationMs } from "./task-timing.ts"

export type { Task }

// ─── Date formatting ─────────────────────────────────────────────────────────

export type DateFormat = "relative" | "absolute"

export function formatDate(date: Date, dateFormat: DateFormat): string {
  if (dateFormat === "absolute") {
    return format(date, "d MMM yyyy, HH:mm")
  }
  return timeAgo(date)
}

export function timeAgo(date: Date): string {
  return formatDistanceToNow(date, { addSuffix: true })
}

// ─── Task rendering ──────────────────────────────────────────────────────────

/** Render a single task to stdout. `sessionTag` is an optional `[shortId]` prefix for cross-session views. */
function renderTaskDescription(task: Task): void {
  if (!task.description) return
  const lines = task.description.split("\n")
  for (const line of lines.slice(0, 3)) console.log(`     ${DIM}${line}${RESET}`)
  if (lines.length > 3) console.log(`     ${DIM}...${RESET}`)
}

function renderTaskTiming(task: Task, dateFormat: DateFormat): void {
  if (task.statusChangedAt) {
    console.log(`     ${DIM}📅 ${formatDate(new Date(task.statusChangedAt), dateFormat)}${RESET}`)
  }
  if (task.status !== "in_progress" && (task.elapsedMs ?? 0) > 0) {
    console.log(`     ${DIM}⏱  ${formatDuration(task.elapsedMs!)} elapsed${RESET}`)
  }
  const completedAtMs = getTaskCompletedAtMs(task)
  if (completedAtMs !== null) {
    console.log(
      `     ${DIM}✓ Completed: ${formatDate(new Date(completedAtMs), dateFormat)}${RESET}`
    )
  }
}

function renderTaskRelations(task: Task): void {
  if (task.completionEvidence)
    console.log(`     ${DIM}✓ Evidence: ${task.completionEvidence}${RESET}`)
  if (task.blockedBy.length)
    console.log(`     ${DIM}Blocked by: #${task.blockedBy.join(", #")}${RESET}`)
  if (task.blocks.length) console.log(`     ${DIM}Blocks: #${task.blocks.join(", #")}${RESET}`)
}

function renderTaskMetadata(task: Task, dateFormat: DateFormat): void {
  renderTaskDescription(task)
  renderTaskTiming(task, dateFormat)
  renderTaskRelations(task)
}

export function renderTask(
  task: Task,
  sessionTag?: string,
  dateFormat: DateFormat = "relative"
): void {
  const { emoji, color } = STATUS_STYLE[task.status]
  const tag = sessionTag ? `${DIM}[${sessionTag}]${RESET} ` : ""
  const durationTag =
    task.status === "in_progress"
      ? `${DIM}(${formatDuration(getTaskCurrentDurationMs(task))})${RESET} `
      : ""
  console.log(
    `  ${emoji} ${BOLD}#${task.id}${RESET} ${tag}${color}[${task.status.replace("_", " ").toUpperCase()}]${RESET} ${durationTag}${task.subject}`
  )
  renderTaskMetadata(task, dateFormat)
  console.log()
}

// ─── Session listing ─────────────────────────────────────────────────────────

const STATUS_GROUP_ORDER: Array<{ title: string; status: Task["status"] }> = [
  { title: "IN PROGRESS", status: "in_progress" },
  { title: "PENDING", status: "pending" },
  { title: "COMPLETED", status: "completed" },
  { title: "CANCELLED", status: "cancelled" },
]

function renderGroupedTasks(
  tasks: Task[],
  sessionTag: string | undefined,
  dateFormat: DateFormat
): void {
  for (const { title, status } of STATUS_GROUP_ORDER) {
    const group = tasks.filter((t) => t.status === status)
    if (group.length === 0) continue
    console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`)
    for (const task of group) renderTask(task, sessionTag, dateFormat)
  }
}

function countTaskStats(tasks: Task[]): { incomplete: number; completed: number } {
  let incomplete = 0
  let completed = 0
  for (const t of tasks) {
    if (t.status === "pending" || t.status === "in_progress") incomplete++
    else if (t.status === "completed") completed++
  }
  return { incomplete, completed }
}

export async function listTasks(
  sessionId: string,
  label: string,
  dateFormat: DateFormat = "relative",
  recovered = false
): Promise<void> {
  const tasks = await readTasks(sessionId)
  const recoveredTag = recovered ? ` ${YELLOW}[recovered]${RESET}` : ""
  console.log(
    `\n  ${BOLD}Tasks${RESET} ${DIM}(${label}: ${sessionId.slice(0, 8)}...)${RESET}${recoveredTag}\n`
  )

  if (tasks.length === 0) {
    console.log("  No tasks found.\n")
    return
  }

  renderGroupedTasks(tasks, undefined, dateFormat)
  const { incomplete, completed } = countTaskStats(tasks)
  console.log(
    `  ${BOLD}Summary:${RESET} ${incomplete}/${tasks.length} incomplete, ${completed} completed\n`
  )
}

export async function listAllSessionsTasks(
  filterCwd?: string,
  dateFormat: DateFormat = "relative",
  recoveredOnly = false
): Promise<void> {
  const [sessions, orphanIds] = await Promise.all([getSessions(filterCwd), getOrphanSessionIds()])
  const filteredSessions = recoveredOnly ? sessions.filter((s) => orphanIds.has(s)) : sessions
  const label = recoveredOnly
    ? "recovered sessions"
    : filterCwd
      ? "current project"
      : "all projects"

  if (filteredSessions.length === 0) {
    console.log(`\n  ${BOLD}Tasks${RESET} ${DIM}(${label}, all sessions)${RESET}\n`)
    console.log(
      recoveredOnly ? "  No recovered (compaction-gap) sessions found.\n" : "  No sessions found.\n"
    )
    return
  }

  let totalTasks = 0
  let totalIncomplete = 0
  let totalCompleted = 0
  let sessionsWithTasks = 0

  for (const sessionId of filteredSessions) {
    const tasks = await readTasks(sessionId)
    if (tasks.length === 0) continue

    sessionsWithTasks++
    totalTasks += tasks.length

    const shortId = sessionId.slice(0, 8)
    const recoveredTag = orphanIds.has(sessionId) ? ` ${YELLOW}[recovered]${RESET}` : ""
    console.log(`\n  ${BOLD}Session${RESET} ${DIM}${shortId}...${RESET}${recoveredTag}\n`)

    renderGroupedTasks(tasks, shortId, dateFormat)

    const { incomplete, completed } = countTaskStats(tasks)
    totalIncomplete += incomplete
    totalCompleted += completed
    console.log(
      `  ${DIM}${incomplete}/${tasks.length} incomplete, ${completed} completed${RESET}\n`
    )
  }

  console.log(
    `\n  ${BOLD}All sessions summary:${RESET} ${sessionsWithTasks} session(s), ` +
      `${totalIncomplete}/${totalTasks} incomplete, ${totalCompleted} completed\n`
  )
}
