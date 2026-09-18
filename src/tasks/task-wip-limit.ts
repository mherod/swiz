// ─── Work-in-progress limit ──────────────────────────────────────────────────
//
// A project may hold at most MAX_IN_PROGRESS_TASKS_PER_PROJECT tasks in
// `in_progress` at once. The cap is project-scoped, not session-scoped: several
// sessions can share one repository, and the cost of a wide WIP front (stale
// tasks, fabricated parallelism in the dashboard totals) is paid per project.
//
// "Project" means the dual-keyed store for this session and this project key —
// the same pair every other gating surface counts. It must never mean "whatever
// the cwd scan turns up": that path admits stores it cannot attribute to any
// project, which made unrelated repositories' tasks fill this project's limit.
//
// This module imports the project key, the task store, and the file lock, none
// of which import task-service.ts, so it cannot participate in a cycle with it.

import { projectKeyFromCwd } from "../project-key.ts"
import { getLockPathForFile, withFileLock } from "../utils/file-lock.ts"
import { readSessionMeta, readTaskStore, readTasksAcrossStores } from "./task-repository.ts"
import { projectStoreKey } from "./task-store-path.ts"

/** Maximum number of simultaneously `in_progress` tasks for one project. */
export const MAX_IN_PROGRESS_TASKS_PER_PROJECT = 4

interface WipTask {
  id: string
  status: string
  subject?: string
}

/**
 * Where a transition came from, used to resolve which project the cap applies
 * to. Both fields are optional: CLI paths know the cwd, MCP paths know the
 * session, and `resolveWipScope` falls back in that order.
 */
export interface WipOrigin {
  filterCwd?: string
  sessionId?: string
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
 * Resolve which project the cap applies to.
 *
 * An explicit `filterCwd` always wins. Otherwise the scope comes from the
 * *target* session's recorded cwd, not from `process.cwd()`: cross-project
 * maintenance (`swiz tasks status --all-projects --session <other>`) passes no
 * cwd deliberately, and counting the current repository there would both admit
 * an extra task in the target project and reject valid transitions because an
 * unrelated project happens to be full.
 */
export async function resolveWipScope(filterCwd?: string, sessionId?: string): Promise<string> {
  if (filterCwd) return filterCwd
  if (sessionId) {
    const meta = await readSessionMeta(sessionId)
    if (meta?.cwd) return meta.cwd
  }
  return process.cwd()
}

/**
 * Read this project's tasks for the cap check.
 *
 * Reads the dual-keyed store directly — this session's store unioned with this
 * project's MCP store — rather than `collectIncompleteTasks`. That resolver
 * scans for sessions whose cwd matches, and its `admitUnattributableSessions`
 * fallback admits any store that no project transcript accounts for so a
 * compaction-gap orphan is not lost. A store carrying neither a transcript nor
 * cwd metadata therefore lands in *every* project's result, and the cap counted
 * unrelated repositories' tasks against this one: a session with nothing of its
 * own in progress was refused because four foreign tasks filled the limit,
 * while `TaskList` — which reads the store directly — correctly reported zero.
 *
 * Reading by key also removes the need to de-duplicate by hand.
 * `readTasksAcrossStores` merges the two stores by id and keeps the most
 * recently changed copy, so a genuine mirror collapses while the session-local
 * `#1`s of unrelated sessions never enter the set to be confused in the first
 * place.
 */
async function readProjectWipTasks(scope: string, sessionId?: string): Promise<WipTask[]> {
  // Never route a project key through the session-id slot. That argument is
  // read as a session id, which resolves to the flat `<tasksDir>/<key>` legacy
  // path rather than `<tasksDir>/.projects/<key>` — two stores for one project,
  // which `readTaskStorePath` then refuses outright rather than silently hiding
  // one of them. With no session id, read the project store by its typed key.
  const tasks = sessionId
    ? await readTasksAcrossStores(sessionId, projectKeyFromCwd(scope))
    : await readTaskStore(projectStoreKey(scope))
  return tasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject }))
}

/**
 * Project-scoped guard used by the transition paths. Reads the incomplete tasks
 * for the resolved scope and throws when the cap would be breached.
 */
export async function assertInProgressLimit(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  filterCwd?: string,
  sessionId?: string
): Promise<void> {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return

  const scope = await resolveWipScope(filterCwd, sessionId)
  const error = checkInProgressLimit(
    taskId,
    currentStatus,
    newStatus,
    await readProjectWipTasks(scope, sessionId)
  )
  if (error) throw new Error(error)
}

/**
 * Hold the project's capacity while `write` persists the transition.
 *
 * The cap is project-wide across concurrent sessions, so a bare check followed
 * by an independent write is not enough: two sessions can read the same
 * three-task snapshot, both pass, and both write, leaving five in progress.
 * The lock is keyed on the resolved project scope, so unrelated projects never
 * serialise against each other, and transitions that cannot breach the cap skip
 * it entirely rather than paying for a lock they do not need.
 */
export async function withInProgressReservation<T>(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  write: () => Promise<T>,
  origin: WipOrigin = {}
): Promise<T> {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return write()

  const scope = await resolveWipScope(origin.filterCwd, origin.sessionId)
  return withFileLock(getLockPathForFile(`swiz-wip-${scope}`), async () => {
    const error = checkInProgressLimit(
      taskId,
      currentStatus,
      newStatus,
      await readProjectWipTasks(scope, origin.sessionId)
    )
    if (error) throw new Error(error)
    return write()
  })
}
