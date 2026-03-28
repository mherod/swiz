/**
 * Core logic for the stop-incomplete-tasks check.
 *
 * Shared by:
 *   - hooks/stop-incomplete-tasks.ts (subprocess hook)
 *   - src/commands/dispatch.ts (in-process fast path for stop events)
 *
 * Returns a hook result object ({ decision, reason }) or null when no block
 * is needed, so each consumer can emit it in its own way.
 */

import { join } from "node:path"
import { orderBy } from "lodash-es"
import { formatActionPlan } from "../../src/action-plan.ts"
import { computeSubjectFingerprint } from "../../src/subject-fingerprint.ts"
import { validateTransition } from "../../src/tasks/task-service.ts"
import {
  autoTransitionForComplete,
  getSessionTasksDir,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  normalizeSubject,
  readSessionTasks,
  type SessionTask,
  subjectsOverlap,
} from "./hook-utils.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StopIncompleteTasksResult {
  decision: "block"
  reason: string
}

type TaskFile = SessionTask

// ─── Deduplication ──────────────────────────────────────────────────────────

function isTaskDuplicate(
  stale: TaskFile,
  completedFingerprints: Set<string>,
  completedNormalized: string[]
): boolean {
  const staleFp = stale.subjectFingerprint ?? computeSubjectFingerprint(stale.subject)
  if (completedFingerprints.has(staleFp)) return true

  const staleNorm = normalizeSubject(stale.subject)
  return completedNormalized.some((cs) => subjectsOverlap(staleNorm, cs))
}

async function completeStaleTask(stale: TaskFile, tasksDir: string): Promise<void> {
  try {
    const taskPath = join(tasksDir, `${stale.id}.json`)
    autoTransitionForComplete(stale)
    if (validateTransition(stale.status, "completed")) return
    const updated = {
      ...stale,
      status: "completed" as const,
      completionEvidence: "note:auto-completed — duplicate of a completed task",
    }
    await Bun.write(taskPath, JSON.stringify(updated, null, 2))
    stale.status = "completed"
  } catch {
    // Write failed — leave as-is and let the block message fire
  }
}

async function deduplicateStaleTasks(
  completedTasks: TaskFile[],
  incompleteTasks: TaskFile[],
  tasksDir: string
): Promise<void> {
  if (completedTasks.length === 0 || incompleteTasks.length === 0) return

  const completedFingerprints = new Set<string>()
  for (const t of completedTasks) {
    completedFingerprints.add(t.subjectFingerprint ?? computeSubjectFingerprint(t.subject))
  }

  const completedNormalized = completedTasks.map((t) => normalizeSubject(t.subject))

  for (const stale of incompleteTasks) {
    if (!isTaskDuplicate(stale, completedFingerprints, completedNormalized)) continue
    await completeStaleTask(stale, tasksDir)
  }
}

// ─── Incomplete detail formatting ───────────────────────────────────────────

function getIncompleteDetails(allTasks: TaskFile[]): string[] {
  const incompleteTaskRows = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is TaskFile => isIncompleteTaskStatus(t.status))
  return orderBy(
    incompleteTaskRows,
    [(task) => (task.status === "in_progress" ? 1 : 0), (task) => Number.parseInt(task.id, 10)],
    ["desc", "asc"]
  ).map((t) => `${t.subject} (task #${t.id})`)
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Check whether a session has incomplete tasks that should block stop.
 *
 * Reads task files, deduplicates stale entries, and returns a block result
 * when incomplete tasks remain — or null when stop is allowed.
 */
export async function checkIncompleteTasks(
  sessionId: string,
  home: string
): Promise<StopIncompleteTasksResult | null> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null

  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists = allTasks.length > 0 || (await hasSessionTasksDir(sessionId, home))
  if (!tasksDirExists || allTasks.length === 0) return null

  // Deduplicate before checking
  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status)
  )
  await deduplicateStaleTasks(completedTasks, incompleteTasks, tasksDir)

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length === 0) return null

  return {
    decision: "block",
    reason: formatActionPlan(
      [
        ...incompleteDetails,
        "If the work is already done, use TaskUpdate to mark each current-session task as completed.",
        "If the work is still needed, complete it before stopping.",
      ],
      { translateToolNames: true, header: "Incomplete tasks found:" }
    ),
  }
}
