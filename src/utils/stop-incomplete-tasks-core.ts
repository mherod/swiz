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

import { orderBy } from "lodash-es"
import { formatActionPlan } from "../action-plan.ts"
import type { HookOutput } from "../schemas.ts"
import {
  buildTaskReviewInstruction,
  getTaskToolName,
  type TaskReviewInstructionContext,
} from "../tasks/task-governance-messages.ts"
import {
  getSessionTasksDir,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionTask,
} from "../tasks/task-recovery.ts"
import { isTaskSubjectCarryoverDeferral } from "../tasks/task-subject-deferral.ts"
import { stopIncompleteTasksLogPath } from "../temp-paths.ts"
import { blockStopObj, isCurrentAgent } from "./hook-utils.ts"

// ─── Incomplete detail formatting ───────────────────────────────────────────

export function getIncompleteDetails(allTasks: SessionTask[]): string[] {
  const incompleteTaskRows = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is SessionTask => isIncompleteTaskStatus(t.status))
    .filter((t) => !isTaskSubjectCarryoverDeferral(t.subject))
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
 * Reads task files and returns a block result when incomplete tasks remain,
 * or null when stop is allowed.
 */
async function logStopDiagnostic(message: string): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises")
    const line = `[${new Date().toISOString()}] stop-incomplete-tasks: ${message}\n`
    await appendFile(stopIncompleteTasksLogPath(), line)
  } catch {
    // best-effort logging
  }
}

export async function checkIncompleteTasks(
  sessionId: string,
  home: string,
  options: TaskReviewInstructionContext = {}
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

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length === 0) {
    await logStopDiagnostic(
      `allow: all tasks complete (session=${sessionId.slice(0, 8)}, total=${allTasks.length})`
    )
    return null
  }

  await logStopDiagnostic(
    `BLOCK: ${incompleteDetails.length} incomplete (session=${sessionId.slice(0, 8)}): ${incompleteDetails.join("; ")}`
  )

  const sourceCtx = buildTaskReviewInstruction(options)
  const taskUpdateToolName = options.taskUpdateToolName ?? getTaskToolName("TaskUpdate")
  const completionStep = taskUpdateToolName
    ? `If the work is already done, use ${taskUpdateToolName} to mark each current-session task as completed.`
    : "If the work is already done, mark each current-session task as completed in the current planning surface."

  return blockStopObj(
    formatActionPlan(
      [
        ...incompleteDetails,
        sourceCtx,
        completionStep,
        "If the work is still needed, complete it before stopping.",
      ],
      {
        translateToolNames: true,
        header: "There are tasks that need your attention before we can finish the session:",
      }
    )
  )
}
