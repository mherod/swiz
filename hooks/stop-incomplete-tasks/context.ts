/**
 * Context resolution for stop-incomplete-tasks validator.
 */

import { join } from "node:path"
import { getHomeDirOrNull } from "../../src/home.ts"
import { projectKeyFromCwd } from "../../src/project-key.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { createTaskStoreForHookPayload } from "../../src/task-roots.ts"
import { isSafeSessionId, readTasksAcrossStores } from "../../src/tasks/task-repository.ts"
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
  if (!sessionId || !isSafeSessionId(sessionId, taskStore.tasksDir)) return null
  const tasksDir = join(taskStore.tasksDir, sessionId)
  const projectKey = input.cwd ? projectKeyFromCwd(input.cwd) : undefined
  const allTasks = await readTasksAcrossStores(sessionId, projectKey, taskStore.tasksDir)

  return {
    sessionId,
    home,
    tasksDir,
    tasksRoot: taskStore.tasksDir,
    projectKey,
    allTasks,
  }
}
