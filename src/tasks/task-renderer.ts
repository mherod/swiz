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
export function renderTask(task: Task, sessionTag?: string, dateFormat: DateFormat = "relative") {
  const { emoji, color } = STATUS_STYLE[task.status]
  const tag = sessionTag ? `${DIM}[${sessionTag}]${RESET} ` : ""
  const durationTag =
    task.status === "in_progress"
      ? `${DIM}(${formatDuration(getTaskCurrentDurationMs(task))})${RESET} `
      : ""
  console.log(
    `  ${emoji} ${BOLD}#${task.id}${RESET} ${tag}${color}[${task.status.replace("_", " ").toUpperCase()}]${RESET} ${durationTag}${task.subject}`
  )
  if (task.description) {
    const lines = task.description.split("\n").slice(0, 3)
    for (const line of lines) console.log(`     ${DIM}${line}${RESET}`)
    if (task.description.split("\n").length > 3) console.log(`     ${DIM}...${RESET}`)
  }
  // Show date — statusChangedAt is always present (backfilled from file mtime)
  if (task.statusChangedAt) {
    console.log(`     ${DIM}📅 ${formatDate(new Date(task.statusChangedAt), dateFormat)}${RESET}`)
  }
  // Show elapsed time for completed tasks after the final status settles.
  if (task.status !== "in_progress" && (task.elapsedMs ?? 0) > 0) {
    console.log(`     ${DIM}⏱  ${formatDuration(task.elapsedMs!)} elapsed${RESET}`)
  }
  if (task.completionEvidence)
    console.log(`     ${DIM}✓ Evidence: ${task.completionEvidence}${RESET}`)
  const completedAtMs = getTaskCompletedAtMs(task)
  if (completedAtMs !== null)
    console.log(
      `     ${DIM}✓ Completed: ${formatDate(new Date(completedAtMs), dateFormat)}${RESET}`
    )
  if (task.blockedBy.length)
    console.log(`     ${DIM}Blocked by: #${task.blockedBy.join(", #")}${RESET}`)
  if (task.blocks.length) console.log(`     ${DIM}Blocks: #${task.blocks.join(", #")}${RESET}`)
  console.log()
}

// ─── Session listing ─────────────────────────────────────────────────────────

export async function listTasks(
  sessionId: string,
  label: string,
  dateFormat: DateFormat = "relative",
  recovered = false
) {
  const tasks = await readTasks(sessionId)
  const recoveredTag = recovered ? ` ${YELLOW}[recovered]${RESET}` : ""
  console.log(
    `\n  ${BOLD}Tasks${RESET} ${DIM}(${label}: ${sessionId.slice(0, 8)}...)${RESET}${recoveredTag}\n`
  )

  if (tasks.length === 0) {
    console.log("  No tasks found.\n")
    return
  }

  const groups: [string, Task[]][] = [
    ["IN PROGRESS", tasks.filter((t: Task) => t.status === "in_progress")],
    ["PENDING", tasks.filter((t: Task) => t.status === "pending")],
    ["COMPLETED", tasks.filter((t: Task) => t.status === "completed")],
    ["CANCELLED", tasks.filter((t: Task) => t.status === "cancelled")],
  ]

  for (const [title, group] of groups) {
    if (group.length === 0) continue
    console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`)
    for (const task of group) renderTask(task, undefined, dateFormat)
  }

  const incomplete = tasks.filter(
    (t: Task) => t.status === "pending" || t.status === "in_progress"
  ).length
  const completed = tasks.filter((t: Task) => t.status === "completed").length
  console.log(
    `  ${BOLD}Summary:${RESET} ${incomplete}/${tasks.length} incomplete, ${completed} completed\n`
  )
}

export async function listAllSessionsTasks(
  filterCwd?: string,
  dateFormat: DateFormat = "relative",
  recoveredOnly = false
) {
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

    const groups: [string, Task[]][] = [
      ["IN PROGRESS", tasks.filter((t: Task) => t.status === "in_progress")],
      ["PENDING", tasks.filter((t: Task) => t.status === "pending")],
      ["COMPLETED", tasks.filter((t: Task) => t.status === "completed")],
      ["CANCELLED", tasks.filter((t: Task) => t.status === "cancelled")],
    ]

    for (const [title, group] of groups) {
      if (group.length === 0) continue
      console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`)
      for (const task of group) renderTask(task, shortId, dateFormat)
    }

    const incomplete = tasks.filter(
      (t: Task) => t.status === "pending" || t.status === "in_progress"
    ).length
    const completed = tasks.filter((t: Task) => t.status === "completed").length
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
