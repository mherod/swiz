/** Bound repeated stops on stale task IDs without releasing real unfinished work. */
import { join } from "node:path"
import { z } from "zod"
import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import { isIncompleteTaskStatus, readTasksAcrossStores } from "../../src/tasks/task-repository.ts"
import type { TaskCheckContext } from "./types.ts"

const MISSING_TASK_LIMIT = 3
const RETRY_WINDOW_MS = 15 * 60_000

const missingTaskStateSchema = z.object({
  fingerprint: z.string(),
  count: z.number().int().min(1).max(MISSING_TASK_LIMIT),
  updatedAt: z.number().finite(),
})

function nextMissingCount(raw: unknown, fingerprint: string, now: number): number {
  const parsed = missingTaskStateSchema.safeParse(raw)
  if (!parsed.success) return 1
  const previous = parsed.data
  if (
    previous.fingerprint !== fingerprint ||
    now < previous.updatedAt ||
    now - previous.updatedAt >= RETRY_WINDOW_MS
  )
    return 1
  return Math.min(MISSING_TASK_LIMIT, previous.count + 1)
}

/** Persist only one digest/counter per session; subprocess and daemon stops share it. */
export async function reconcileStopTaskSnapshot(
  ctx: TaskCheckContext
): Promise<{ tasks: SessionTask[]; notice?: string }> {
  const current = await readTasksAcrossStores(ctx.sessionId, ctx.projectKey, ctx.tasksRoot)
  const currentIds = new Set(current.map((task) => task.id))
  const missing = ctx.allTasks.filter(
    (task) => isIncompleteTaskStatus(task.status) && !currentIds.has(task.id)
  )
  if (!ctx.tasksDir) return { tasks: current }
  const stateFile = Bun.file(join(ctx.tasksDir, ".stop-missing-tasks.json"))
  try {
    if (missing.length === 0) {
      if (await stateFile.exists()) await Bun.write(stateFile, "{}")
      return { tasks: current }
    }
    const hasher = new Bun.CryptoHasher("sha256")
    for (const task of [...missing].sort((a, b) => a.id.localeCompare(b.id))) {
      hasher.update(JSON.stringify([task.id, task.status, task.subject]))
    }
    const fingerprint = hasher.digest("hex")
    const previous: unknown = await stateFile.json().catch(() => null)
    const now = Date.now()
    const count = nextMissingCount(previous, fingerprint, now)
    await Bun.write(stateFile, JSON.stringify({ fingerprint, count, updatedAt: now }))
    if (count < MISSING_TASK_LIMIT) return { tasks: [...current, ...missing] }
    return {
      tasks: current,
      notice:
        `Released stale task blocker(s) after ${MISSING_TASK_LIMIT} identical checks: ` +
        `${missing
          .slice(0, 5)
          .map((task) => `#${task.id}`)
          .join(", ")}. ` +
        "These IDs are absent from both the session and project task stores. " +
        "Any tasks still present and incomplete remain blocking.",
    }
  } catch {
    return { tasks: [...current, ...missing] }
  }
}
