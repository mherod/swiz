/**
 * Incomplete task detection validator.
 *
 * Helper to filter incomplete tasks by status.
 */

import { isIncompleteTaskStatus, type SessionTask } from "../../src/tasks/task-recovery.ts"

export function filterIncompleteStatus(allTasks: SessionTask[]): SessionTask[] {
  return allTasks.filter((t): t is SessionTask => isIncompleteTaskStatus(t.status))
}
