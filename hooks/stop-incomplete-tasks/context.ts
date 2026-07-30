/**
 * Context resolution for stop-incomplete-tasks validator.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDirOrNull } from "../../src/home.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { createTaskStoreForHookPayload } from "../../src/task-roots.ts"
import { readTasks } from "../../src/tasks/task-repository.ts"
import type { TaskCheckContext } from "./types.ts"

/**
 * Resolve task check context from stop hook input.
 */
export async function resolveTaskCheckContext(
  input: StopHookInput,
  homeOverride?: string
): Promise<TaskCheckContext | null> {
  const sessionId = input.session_id ?? ""
  const home = homeOverride ?? getHomeDirOrNull()
  if (!home) return null

  const taskStore = createTaskStoreForHookPayload(input as Record<string, any>, home)
  const tasksDir = join(taskStore.tasksDir, sessionId)
  try {
    await readdir(tasksDir)
  } catch {
    return null
  }

  const allTasks = await readTasks(sessionId, taskStore.tasksDir)

  return {
    sessionId,
    home,
    tasksDir,
    allTasks,
  }
}
