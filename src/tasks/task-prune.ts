/**
 * Task pruning — deletes task files past a retention age. Two rules apply:
 * completed tasks go once they have been done for COMPLETED_TASK_PRUNE_AGE_MS,
 * and a task of any status goes once its last recorded activity is older than
 * STALE_TASK_PRUNE_AGE_MS.
 *
 * Session-keyed stores are pruned by TaskStateCache full loads (daemon path).
 * The project-keyed store is pruned only by the swiz MCP task tools, where a
 * task mutation or query is an explicit agent action; passive read paths such
 * as the daemon status line must never prune it (see readProjectStoreTasks in
 * compliance-routes.ts for the incident that rule comes from).
 *
 * Leaf module: node builtins + governance constants only, so both the cache
 * and the MCP server can import it without a cycle.
 */

import { unlink } from "node:fs/promises"
import { resolveTaskFilePath } from "./task-file-path.ts"
import {
  COMPLETED_TASK_PRUNE_AGE_MS,
  STALE_TASK_PRUNE_AGE_MS,
} from "./task-governance-constants.ts"
import { parseIsoTimestampMs } from "./task-timing.ts"

/** The fields pruning needs; satisfied by both `Task` and `SessionTask`. */
interface PrunableTask {
  id: string
  status: string
  startedAt?: number | null
  completedAt?: number | null
  statusChangedAt?: string | null
}

/**
 * Epoch ms of the task's most recent recorded activity, or null when the
 * record carries no usable timestamp at all. `statusChangedAt` is stamped on
 * every status change, so it is the primary anchor; the numeric fields cover
 * records written before it existed.
 */
function lastActivityMs(task: PrunableTask): number | null {
  const candidates = [
    parseIsoTimestampMs(task.statusChangedAt),
    typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
      ? task.completedAt
      : null,
    typeof task.startedAt === "number" && Number.isFinite(task.startedAt) ? task.startedAt : null,
  ].filter((value): value is number => value !== null)
  return candidates.length === 0 ? null : Math.max(...candidates)
}

/**
 * Remove tasks that have aged out under either rule: completed for more than
 * `maxAgeMs`, or last touched more than `staleMaxAgeMs` ago regardless of
 * status. Deletes their .json files from disk and returns only the surviving
 * tasks. A record carrying no usable timestamp is always kept — its age is
 * unknown, and guessing would delete live work. Fail-open: deletion errors
 * are ignored and the task is still dropped from the returned list.
 */
export async function pruneStaleCompletedTasks<T extends PrunableTask>(
  dir: string,
  tasks: readonly T[],
  maxAgeMs: number = COMPLETED_TASK_PRUNE_AGE_MS,
  staleMaxAgeMs: number = STALE_TASK_PRUNE_AGE_MS
): Promise<T[]> {
  const now = Date.now()
  const completedCutoff = now - maxAgeMs
  const staleCutoff = now - staleMaxAgeMs
  const surviving: T[] = []
  for (const task of tasks) {
    if (shouldPrune(task, completedCutoff, staleCutoff)) {
      // The id is record content, not the filename it was read from, so it can
      // name a path outside the store. Keep an unusable record instead.
      const path = resolveTaskFilePath(dir, task.id)
      if (path === null) {
        surviving.push(task)
        continue
      }
      try {
        await unlink(path)
      } catch {
        // already gone or locked — treat as pruned
      }
      continue
    }
    surviving.push(task)
  }
  return surviving
}

function shouldPrune(task: PrunableTask, completedCutoff: number, staleCutoff: number): boolean {
  if (task.status === "completed" && task.completedAt != null && task.completedAt < completedCutoff)
    return true
  const activityMs = lastActivityMs(task)
  return activityMs !== null && activityMs < staleCutoff
}
