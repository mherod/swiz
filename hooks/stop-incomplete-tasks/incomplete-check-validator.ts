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
import {
  isTaskSubjectCarryoverDeferral,
  stripTaskSubjectCarryoverDeferralPrefix,
} from "../../src/tasks/task-subject-deferral.ts"

export function isDeferredSubject(subject: string | undefined | null): boolean {
  return isTaskSubjectCarryoverDeferral(subject)
}

export function stripDeferralPrefix(subject: string): string {
  return stripTaskSubjectCarryoverDeferralPrefix(subject)
}

export function filterIncompleteStatus(allTasks: SessionTask[]): SessionTask[] {
  return allTasks.filter((t): t is SessionTask => isIncompleteTaskStatus(t.status))
}

export function filterBlockingIncomplete(allTasks: SessionTask[]): SessionTask[] {
  return filterIncompleteStatus(allTasks).filter((t) => !isDeferredSubject(t.subject))
}
