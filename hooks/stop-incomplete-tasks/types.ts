/**
 * Type definitions for stop-incomplete-tasks validator.
 */

import type { SessionTask } from "../../src/tasks/task-recovery.ts"

export interface TaskCheckContext {
  sessionId: string
  home: string
  tasksDir: string | null
  allTasks: SessionTask[]
}

export interface TaskCheckResult {
  kind: "ok" | "incomplete-detected"
  incompleteTasks?: SessionTask[]
  taskDetails?: string[]
}
