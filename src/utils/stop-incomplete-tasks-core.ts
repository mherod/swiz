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
import { formatActionPlan } from "../action-plan.ts"
import type { HookOutput } from "../schemas.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { warnInvalidTransition } from "../tasks/task-event-state.ts"
import {
  getSessionTasksDir,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionTask,
} from "../tasks/task-recovery.ts"
import { validateTransition } from "../tasks/task-service.ts"
import {
  autoTransitionForComplete,
  blockStopObj,
  isCurrentAgent,
  normalizeSubject,
  subjectsOverlap,
} from "./hook-utils.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

// ─── Deduplication ──────────────────────────────────────────────────────────

export function isTaskDuplicate(
  stale: SessionTask,
  completedFingerprints: Set<string>,
  completedNormalized: string[]
): boolean {
  const staleFp = stale.subjectFingerprint ?? computeSubjectFingerprint(stale.subject)
  if (completedFingerprints.has(staleFp)) return true

  const staleNorm = normalizeSubject(stale.subject)
  return completedNormalized.some((cs) => subjectsOverlap(staleNorm, cs))
}

export async function completeStaleTask(
  stale: SessionTask,
  tasksDir: string,
  autoTransitionEnabled: boolean,
  sessionId: string
): Promise<void> {
  try {
    const taskPath = join(tasksDir, `${stale.id}.json`)
    autoTransitionForComplete(stale, autoTransitionEnabled)
    if (validateTransition(stale.status, "completed")) {
      warnInvalidTransition("stop-dedup", sessionId, stale.id, stale.status, "completed")
      return
    }
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

export async function deduplicateStaleTasks(
  completedTasks: SessionTask[],
  incompleteTasks: SessionTask[],
  tasksDir: string,
  autoTransitionEnabled: boolean,
  sessionId: string
): Promise<void> {
  if (completedTasks.length === 0 || incompleteTasks.length === 0) return

  const completedFingerprints = new Set<string>()
  for (const t of completedTasks) {
    completedFingerprints.add(t.subjectFingerprint ?? computeSubjectFingerprint(t.subject))
  }

  const completedNormalized = completedTasks.map((t) => normalizeSubject(t.subject))

  for (const stale of incompleteTasks) {
    if (!isTaskDuplicate(stale, completedFingerprints, completedNormalized)) continue
    await completeStaleTask(stale, tasksDir, autoTransitionEnabled, sessionId)
  }
}

// ─── Incomplete detail formatting ───────────────────────────────────────────

/**
 * Subjects starting with "Consider", "Future:", or "Follow-up:" represent
 * forward-looking notes intentionally deferred past the current session and
 * must not block stop. Mirrors `isDeferredSubject` in
 * hooks/stop-incomplete-tasks/incomplete-check-validator.ts. See #580.
 */
const DEFERRED_SUBJECT_RE = /^\s*(?:consider\b|future\s*:|follow[-\s]?up\s*:)/i

function isDeferredSubject(subject: string | undefined | null): boolean {
  return typeof subject === "string" && DEFERRED_SUBJECT_RE.test(subject)
}

export function getIncompleteDetails(allTasks: SessionTask[]): string[] {
  const incompleteTaskRows = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is SessionTask => isIncompleteTaskStatus(t.status))
    .filter((t) => !isDeferredSubject(t.subject))
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
async function logStopDiagnostic(message: string): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises")
    const line = `[${new Date().toISOString()}] stop-incomplete-tasks: ${message}\n`
    await appendFile("/tmp/swiz-logging.log", line)
  } catch {
    // best-effort logging
  }
}

export async function checkIncompleteTasks(
  sessionId: string,
  home: string,
  autoTransitionEnabled = true
): Promise<HookOutput | null> {
  if (isCurrentAgent("gemini")) {
    await logStopDiagnostic(`skip: gemini agent (session=${sessionId.slice(0, 8)})`)
    return null
  }

  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) {
    await logStopDiagnostic(`skip: no tasksDir (session=${sessionId.slice(0, 8)}, home=${home})`)
    return null
  }

  // Use direct disk read — not cache-backed readSessionTasksFresh — because the
  // daemon's TaskStateCache can contain phantom tasks from inline PostToolUse
  // hooks that processed subagent skill transcripts (e.g. /commit, /push).
  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists = allTasks.length > 0 || (await hasSessionTasksDir(sessionId, home))

  await logStopDiagnostic(
    `read: session=${sessionId.slice(0, 8)} tasks=${allTasks.length} dirExists=${tasksDirExists} ` +
      `statuses=${allTasks.map((t) => `${t.id}:${t.status}`).join(",")}`
  )

  if (!tasksDirExists || allTasks.length === 0) {
    await logStopDiagnostic(`allow: no tasks found (session=${sessionId.slice(0, 8)})`)
    return null
  }

  // Deduplicate before checking
  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status)
  )
  await deduplicateStaleTasks(
    completedTasks,
    incompleteTasks,
    tasksDir,
    autoTransitionEnabled,
    sessionId
  )

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length === 0) {
    await logStopDiagnostic(
      `allow: all tasks complete after dedup (session=${sessionId.slice(0, 8)}, total=${allTasks.length})`
    )
    return null
  }

  await logStopDiagnostic(
    `BLOCK: ${incompleteDetails.length} incomplete (session=${sessionId.slice(0, 8)}): ${incompleteDetails.join("; ")}`
  )

  return blockStopObj(
    formatActionPlan(
      [
        ...incompleteDetails,
        "If the work is already done, use TaskUpdate to mark each current-session task as completed.",
        "If the work is still needed, complete it before stopping.",
      ],
      {
        translateToolNames: true,
        header: "There are tasks that need your attention before we can finish the session:",
      }
    )
  )
}
