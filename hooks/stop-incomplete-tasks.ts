#!/usr/bin/env bun
// Block stop when incomplete tasks remain in the current session.
// Runs before the completion auditor so incomplete tasks are caught early.

import { join } from "node:path"
import { orderBy } from "lodash-es"
import { getHomeDirOrNull } from "../src/home.ts"
import { stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  computeSubjectFingerprint,
  formatActionPlan,
  getSessionTasksDir,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  normalizeSubject,
  readSessionTasks,
  type SessionTask,
  subjectsOverlap,
} from "./utils/hook-utils.ts"

type TaskFile = SessionTask

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
    if (stale.status === "pending") stale.status = "in_progress"
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

function getIncompleteDetails(allTasks: TaskFile[]): string[] {
  const incompleteTaskRows = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is TaskFile => isIncompleteTaskStatus(t.status))
  return orderBy(
    incompleteTaskRows,
    [(task) => (task.status === "in_progress" ? 1 : 0), (task) => Number.parseInt(task.id, 10)],
    ["desc", "asc"]
  ).map((t) => `#${t.id} [${t.status}]: ${t.subject}`)
}

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = stopHookInputSchema.parse(raw)
  const sessionId = input.session_id ?? ""
  const home = getHomeDirOrNull()
  if (!home) return
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return

  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists = allTasks.length > 0 || (await hasSessionTasksDir(sessionId, home))
  if (!tasksDirExists || allTasks.length === 0) return

  // Deduplicate before checking
  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status)
  )
  await deduplicateStaleTasks(completedTasks, incompleteTasks, tasksDir)

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length > 0) {
    blockStop(
      "Incomplete tasks found.\n\n" +
        formatActionPlan(
          [
            "Current task list:",
            incompleteDetails,
            "If the work is already done, use TaskUpdate to mark each current-session task as completed.",
            "If the work is still needed, complete it before stopping.",
          ],
          { translateToolNames: true }
        )
    )
  }
}

if (import.meta.main) {
  void main()
}
