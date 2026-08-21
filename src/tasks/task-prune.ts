/**
 * Completed-task pruning — deletes completed task files past a retention age.
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
import { join } from "node:path"
import { COMPLETED_TASK_PRUNE_AGE_MS } from "./task-governance-constants.ts"

/** The fields pruning needs; satisfied by both `Task` and `SessionTask`. */
interface PrunableTask {
  id: string
  status: string
  completedAt?: number | null
}

/**
 * Remove completed tasks that have been done for more than `maxAgeMs`.
 * Deletes their .json files from disk and returns only the surviving tasks.
 * Cancelled tasks are never pruned — they carry no `completedAt` and their
 * retention is a separate decision. Fail-open: deletion errors are ignored
 * and the task is still dropped from the returned list.
 */
export async function pruneStaleCompletedTasks<T extends PrunableTask>(
  dir: string,
  tasks: readonly T[],
  maxAgeMs: number = COMPLETED_TASK_PRUNE_AGE_MS
): Promise<T[]> {
  const cutoff = Date.now() - maxAgeMs
  const surviving: T[] = []
  for (const task of tasks) {
    if (task.status === "completed" && task.completedAt != null && task.completedAt < cutoff) {
      try {
        await unlink(join(dir, `${task.id}.json`))
      } catch {
        // already gone or locked — treat as pruned
      }
      continue
    }
    surviving.push(task)
  }
  return surviving
}
