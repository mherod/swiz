/**
 * Context resolution for stop-incomplete-tasks validator.
 */

import { getHomeDirOrNull } from "../../src/home.ts"
import {
  getSessionTasksDir,
  hasSessionTasksDir,
  readSessionTasks,
} from "../../src/tasks/task-recovery.ts"
import type { StopHookInput } from "../schemas.ts"
import type { TaskCheckContext } from "./types.ts"

/**
 * Resolve task check context from stop hook input.
 */
export async function resolveTaskCheckContext(
  input: StopHookInput
): Promise<TaskCheckContext | null> {
  const sessionId = input.session_id ?? ""
  const home = getHomeDirOrNull()
  if (!home) return null

  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir && !(await hasSessionTasksDir(sessionId, home))) {
    return null
  }

  const allTasks = await readSessionTasks(sessionId, home)

  return {
    sessionId,
    home,
    tasksDir,
    allTasks,
  }
}
