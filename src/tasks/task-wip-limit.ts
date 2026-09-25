/** Project capacity uses exactly the same attributed records as TaskList. */
import { resolve } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { getLockPathForFile, withFileLock } from "../utils/file-lock.ts"
import { projectQueueTasks, TASK_QUEUE_RECOVERY, taskOwnershipSuffix } from "./task-queue-view.ts"
import {
  readTaskRecordsAcrossStores,
  readTaskStoreMeta,
  type TaskStoreKey,
} from "./task-repository.ts"

export const MAX_IN_PROGRESS_TASKS_PER_PROJECT = 4

interface WipTask {
  id: string
  status: string
  subject?: string
  ownership?: string
}

/** Only a transition into in_progress consumes a slot; same-status updates remain legal. */
export function checkInProgressLimit(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  projectTasks: ReadonlyArray<WipTask>
): string | null {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return null
  // The transitioning task is pending. Filtering by bare ID here would also hide
  // another session's unrelated in-progress #1.
  const others = projectTasks.filter((task) => task.status === "in_progress")
  if (others.length < MAX_IN_PROGRESS_TASKS_PER_PROJECT) return null
  const listed = others
    .slice(0, MAX_IN_PROGRESS_TASKS_PER_PROJECT)
    .map(
      (task) =>
        `  #${task.id}${task.subject ? `: ${task.subject}` : ""}${taskOwnershipSuffix(task)}`
    )
    .join("\n")
  // Finished pending work is not stuck behind the cap: the evidenced one-step close never takes a
  // slot, so name it rather than leave cancellation as the only visible exit (#930).
  const finishedWork =
    currentStatus === "pending"
      ? `\nIf the work for #${taskId} is already finished, complete it directly with the evidence ` +
        "in the update's description instead; that does not take an in_progress slot (needs taskAutoTransition, on by default)."
      : ""
  return (
    `Cannot move #${taskId} to in_progress: this project already has ${others.length} ` +
    `in_progress tasks (limit ${MAX_IN_PROGRESS_TASKS_PER_PROJECT}).\n${listed}\n${TASK_QUEUE_RECOVERY}${finishedWork}`
  )
}

export interface WipOrigin {
  filterCwd?: string
  tasksDir?: string
  storeKey?: TaskStoreKey
}

function wipProjectKey(origin: WipOrigin): string {
  return origin.storeKey?.kind === "project"
    ? origin.storeKey.key
    : projectKeyFromCwd(origin.filterCwd ?? process.cwd())
}

/** Cross-project maintenance follows the target's owner when no explicit scope is supplied. */
async function resolveWipOrigin(origin: WipOrigin): Promise<WipOrigin> {
  if (origin.filterCwd || origin.storeKey?.kind !== "session") return origin
  const meta = await readTaskStoreMeta(origin.storeKey, origin.tasksDir, true)
  return { ...origin, filterCwd: meta?.cwd ?? process.cwd() }
}

export async function assertInProgressLimit(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  origin: WipOrigin = {}
): Promise<void> {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return
  origin = await resolveWipOrigin(origin)
  const { storeKey, tasksDir } = origin
  const records = await readTaskRecordsAcrossStores(
    storeKey?.kind === "session" ? storeKey.id : undefined,
    wipProjectKey(origin),
    tasksDir
  )
  const error = checkInProgressLimit(taskId, currentStatus, newStatus, projectQueueTasks(records))
  if (error) throw new Error(error)
}

/** Serialize the capacity check and persisted write across project sessions/processes. */
export async function withInProgressReservation<T>(
  taskId: string,
  currentStatus: string,
  newStatus: string,
  write: () => Promise<T>,
  origin: WipOrigin
): Promise<T> {
  if (newStatus !== "in_progress" || currentStatus === "in_progress") return write()
  // Resolve once before choosing the lock so explicitly scoped and metadata-
  // scoped callers for the same project serialize through the same reservation.
  origin = await resolveWipOrigin(origin)
  const root = resolve(origin.tasksDir ?? createDefaultTaskStore().tasksDir)
  const lock = getLockPathForFile(`${root}\0${wipProjectKey(origin)}\0wip`)
  return withFileLock(lock, async () => {
    await assertInProgressLimit(taskId, currentStatus, newStatus, { ...origin, tasksDir: root })
    return write()
  })
}
