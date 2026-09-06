/**
 * Context resolution for the stop-completion-auditor validation pipeline.
 *
 * Loads settings, validates prerequisites, and determines which validation gates
 * (task creation, audit log, CI evidence) should be active.
 */

import { join } from "node:path"
import { getHomeDirOrNull } from "../../src/home.ts"
import { projectKeyFromCwd } from "../../src/project-key.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import { createTaskStoreForHookPayload } from "../../src/task-roots.ts"
import { isSafeSessionId, readTasksAcrossStores } from "../../src/tasks/task-repository.ts"
import { getTranscriptSummary } from "../../src/transcript-summary.ts"
import type { CompletionAuditContext, CompletionValidationGate } from "./types.ts"

function resolveAuditStores(input: StopHookInput, home: string) {
  const store = createTaskStoreForHookPayload(input, home)
  const sessionId = input.session_id ?? ""
  if (!sessionId || !isSafeSessionId(sessionId, store.tasksDir)) return null
  const projectKey = input.cwd ? projectKeyFromCwd(input.cwd) : undefined
  return {
    root: store.tasksDir,
    projectKey,
    tasksDir: join(store.tasksDir, sessionId),
    taskStoreDirs: [...new Set([sessionId, ...(projectKey ? [projectKey] : [])])].map((key) =>
      join(store.tasksDir, key)
    ),
  }
}

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

  const store = resolveAuditStores(input, home)
  if (!store) return null

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
    const allTasks = await readTasksAcrossStores(sessionId, store.projectKey, store.root)

    // Load transcript summary for tool stats
    const summary = transcript ? getTranscriptSummary(raw) : null

    return {
      cwd,
      sessionId,
      transcript,
      home,
      tasksDir: store.tasksDir,
      taskStoreDirs: store.taskStoreDirs,
      gates,
      allTasks,
      toolCallCount: 0, // Will be set by caller
      taskToolUsed: false, // Will be set by caller
      observedToolNames: [], // Will be set by caller
      recentObservedToolNames: [], // Will be set by caller
      summary,
    }
  } catch {
    // Fail-open: settings loading errors don't block stop
    return null
  }
}
