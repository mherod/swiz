// ─── Work-in-progress limit ──────────────────────────────────────────────────
//
// A project may hold at most MAX_IN_PROGRESS_TASKS_PER_PROJECT tasks in
// `in_progress` at once. The cap is project-scoped, not session-scoped: several
// sessions can share one repository, and the cost of a wide WIP front (stale
// tasks, fabricated parallelism in the dashboard totals) is paid per project.
//
// This module imports only the resolver, so it cannot participate in a cycle
// with task-service.ts.

import { collectIncompleteTasks } from "./task-resolver.ts"

/** Maximum number of simultaneously `in_progress` tasks for one project. */
export const MAX_IN_PROGRESS_TASKS_PER_PROJECT = 4

interface WipTask {
  id: string
  status: string
  subject?: string
}

/**
 * Pure core: returns an error string when moving `taskId` to `newStatus` would
 * push the project past the in-progress cap, or null when the transition is
 * allowed.
 *
 * Only transitions *into* `in_progress` can breach the cap; a task already
 * in_progress would be re-counted as itself and so is always allowed to stay.
 */
export function checkInProgressLimit(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  projectTasks: ReadonlyArray<WipTask>
): string | null {
  if (newStatus !== "in_progress") return null
  if (currentStatus === "in_progress") return null

  const others = projectTasks.filter((t) => t.id !== taskId && t.status === "in_progress")
  if (others.length < MAX_IN_PROGRESS_TASKS_PER_PROJECT) return null

  const listed = others
    .slice(0, MAX_IN_PROGRESS_TASKS_PER_PROJECT)
    .map((t) => `  #${t.id}${t.subject ? `: ${t.subject}` : ""}`)
    .join("\n")
  return (
    `Cannot move #${taskId} to in_progress: this project already has ${others.length} ` +
    `in_progress task${others.length === 1 ? "" : "s"} ` +
    `(limit ${MAX_IN_PROGRESS_TASKS_PER_PROJECT}).\n${listed}\n` +
    `Complete or cancel one of them first.`
  )
}

/**
 * Project-scoped guard used by the transition paths. Reads the incomplete tasks
 * for `filterCwd` and throws when the cap would be breached.
 */
export async function assertInProgressLimit(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  filterCwd?: string
): Promise<void> {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return

  const incomplete = await collectIncompleteTasks(filterCwd ?? process.cwd())
  const seen = new Set<string>()
  const projectTasks: WipTask[] = []
  for (const { task } of incomplete) {
    if (seen.has(task.id)) continue
    seen.add(task.id)
    projectTasks.push({ id: task.id, status: task.status, subject: task.subject })
  }

  const error = checkInProgressLimit(taskId, currentStatus, newStatus, projectTasks)
  if (error) throw new Error(error)
}
