/**
 * Incomplete task detection validator.
 *
 * Helper to filter incomplete tasks by status, with deferred-subject exemption.
 *
 * Subjects prefixed with "Consider ", "Future:", or "Follow-up:" represent
 * forward-looking notes carried over to the next session — they satisfy the
 * planning buffer for hygiene but should not block stop. See issue #563.
 */

import { isIncompleteTaskStatus, type SessionTask } from "../../src/tasks/task-recovery.ts"

const DEFERRED_SUBJECT_RE = /^\s*(?:consider\b|future\s*:|follow[-\s]?up\s*:)/i

export function isDeferredSubject(subject: string | undefined | null): boolean {
  return typeof subject === "string" && DEFERRED_SUBJECT_RE.test(subject)
}

export function filterIncompleteStatus(allTasks: SessionTask[]): SessionTask[] {
  return allTasks.filter((t): t is SessionTask => isIncompleteTaskStatus(t.status))
}

export function filterBlockingIncomplete(allTasks: SessionTask[]): SessionTask[] {
  return filterIncompleteStatus(allTasks).filter((t) => !isDeferredSubject(t.subject))
}
