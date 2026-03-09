/**
 * Task rendering layer — terminal formatting and display.
 * Owns: DateFormat, formatDate, timeAgo, renderTask, listTasks, listAllSessionsTasks.
 */

import { BOLD, DIM, RESET } from "../ansi.ts"
import { formatDuration } from "../format-duration.ts"
import { readTasks, STATUS_STYLE, type Task } from "./task-repository.ts"
import { getSessions } from "./task-resolver.ts"

export type { Task }

// ─── Date formatting ─────────────────────────────────────────────────────────

export type DateFormat = "relative" | "absolute"

export function formatDate(date: Date, format: DateFormat): string {
  if (format === "absolute") {
    return date.toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }
  return timeAgo(date)
}

export function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(ms / 3600000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(ms / 86400000)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

// ─── Task rendering ──────────────────────────────────────────────────────────

/** Render a single task to stdout. `sessionTag` is an optional `[shortId]` prefix for cross-session views. */
export function renderTask(task: Task, sessionTag?: string, dateFormat: DateFormat = "relative") {
  const { emoji, color } = STATUS_STYLE[task.status]
  const tag = sessionTag ? `${DIM}[${sessionTag}]${RESET} ` : ""
  console.log(
    `  ${emoji} ${BOLD}#${task.id}${RESET} ${tag}${color}[${task.status.replace("_", " ").toUpperCase()}]${RESET} ${task.subject}`
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
  // Show elapsed time for in_progress (live) and completed tasks
  if (task.status === "in_progress" && task.statusChangedAt) {
    const live = (task.elapsedMs ?? 0) + (Date.now() - new Date(task.statusChangedAt).getTime())
    console.log(`     ${DIM}⏱  ${formatDuration(Math.max(0, live))} elapsed${RESET}`)
  } else if ((task.elapsedMs ?? 0) > 0) {
    console.log(`     ${DIM}⏱  ${formatDuration(task.elapsedMs!)} elapsed${RESET}`)
  }
  if (task.completionEvidence)
    console.log(`     ${DIM}✓ Evidence: ${task.completionEvidence}${RESET}`)
  if (task.completionTimestamp)
    console.log(
      `     ${DIM}✓ Completed: ${formatDate(new Date(task.completionTimestamp), dateFormat)}${RESET}`
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
  dateFormat: DateFormat = "relative"
) {
  const tasks = await readTasks(sessionId)
  console.log(`\n  ${BOLD}Tasks${RESET} ${DIM}(${label}: ${sessionId.slice(0, 8)}...)${RESET}\n`)

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
  dateFormat: DateFormat = "relative"
) {
  const sessions = await getSessions(filterCwd)
  const label = filterCwd ? "current project" : "all projects"

  if (sessions.length === 0) {
    console.log(`\n  ${BOLD}Tasks${RESET} ${DIM}(${label}, all sessions)${RESET}\n`)
    console.log("  No sessions found.\n")
    return
  }

  let totalTasks = 0
  let totalIncomplete = 0
  let totalCompleted = 0
  let sessionsWithTasks = 0

  for (const sessionId of sessions) {
    const tasks = await readTasks(sessionId)
    if (tasks.length === 0) continue

    sessionsWithTasks++
    totalTasks += tasks.length

    const shortId = sessionId.slice(0, 8)
    console.log(`\n  ${BOLD}Session${RESET} ${DIM}${shortId}...${RESET}\n`)

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
