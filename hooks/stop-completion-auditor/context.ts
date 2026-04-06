/**
 * Context resolution for the stop-completion-auditor validation pipeline.
 *
 * Loads settings, validates prerequisites, and determines which validation gates
 * (task creation, audit log, CI evidence) should be active.
 */

import { getHomeDirOrNull } from "../../src/home.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import { getSessionTasksDir, readSessionTasksFresh } from "../../src/tasks/task-recovery.ts"
import { getTranscriptSummary } from "../../src/utils/hook-utils.ts"
import type { CompletionAuditContext, CompletionValidationGate } from "./types.ts"

/**
 * Resolve all prerequisites and settings for the completion auditor.
 * Returns null (fail-open) if any prerequisite fails.
 */
export async function resolveCompletionAuditContext(
  input: StopHookInput,
  raw: Record<string, any>
): Promise<CompletionAuditContext | null> {
  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? ""
  const transcript = input.transcript_path ?? ""
  const home = getHomeDirOrNull()

  // Fail-open: must have home directory and session ID
  if (!home || !sessionId) return null

  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null

  // Load settings to determine gate configuration
  try {
    const [globalSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])

    const effective = getEffectiveSwizSettings(globalSettings, sessionId, projectSettings)

    const gates: CompletionValidationGate = {
      taskCreation: true, // Always check task creation
      auditLog: true, // Always try audit log fallback
      ciEvidence: !(effective.ignoreCi ?? false), // Respect ignoreCi setting
    }

    // Load fresh task state
    const allTasks = await readSessionTasksFresh(sessionId, home)

    // Load transcript summary for tool stats
    const summary = transcript ? getTranscriptSummary(raw) : null

    return {
      cwd,
      sessionId,
      transcript,
      home,
      tasksDir,
      gates,
      allTasks,
      toolCallCount: 0, // Will be set by caller
      taskToolUsed: false, // Will be set by caller
      observedToolNames: [], // Will be set by caller
      summary,
    }
  } catch {
    // Fail-open: settings loading errors don't block stop
    return null
  }
}
