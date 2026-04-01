#!/usr/bin/env bun
// Stop hook: Verify task creation and CI evidence after all tasks are complete.
// Incomplete-task blocking is handled by the higher-priority stop-incomplete-tasks hook.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "../src/home.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  getSessionTasksDir,
  getTasksRoot,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionTask,
} from "../src/tasks/task-recovery.ts"
import {
  blockStopObj,
  computeTranscriptSummary,
  deriveCurrentSessionTaskToolStats,
  formatActionPlan,
  getCurrentSessionTaskToolStats,
  getTranscriptSummary,
  mergeActionPlanIntoTasks,
  type TranscriptSummary,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const TOOL_CALL_THRESHOLD = 10

/**
 * Extract sibling session IDs from the same project directory.
 * The transcript path is `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
 * All `.jsonl` files in the parent directory are sibling sessions.
 */
async function findProjectSessionIds(
  transcriptPath: string,
  currentSessionId: string
): Promise<string[]> {
  const projectDir = dirname(transcriptPath)
  try {
    const files = await readdir(projectDir)
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6))
      .filter((id) => id !== currentSessionId)
  } catch {
    return []
  }
}

type TaskFile = SessionTask

interface AuditEntry {
  action: string
  taskId: string
  newStatus?: string
  timestamp?: string
}

const CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i

function taskHasCiEvidence(t: TaskFile): boolean {
  return (
    (!!t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
    (!!t.subject && CI_EVIDENCE_RE.test(t.subject))
  )
}

function anyTaskHasCiEvidence(tasks: TaskFile[]): boolean {
  return tasks.filter((t) => t.status === "completed").some(taskHasCiEvidence)
}

/** Check audit log when no live task files exist; returns null if stop is allowed. */
async function checkAuditLogAllowsStop(
  tasksDir: string,
  taskToolUsed: boolean,
  toolCallCount: number,
  sessionId?: string,
  cwd?: string
): Promise<SwizHookOutput | null> {
  const auditLog = join(tasksDir, ".audit-log.jsonl")
  try {
    const auditText = await Bun.file(auditLog).text()
    const entries: AuditEntry[] = auditText
      .trim()
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean) as AuditEntry[]

    const created = entries.filter((e) => e.action === "create").length
    const latestStatus = new Map<string, string>()
    for (const e of entries) {
      if (e.action === "status_change" && e.newStatus) {
        latestStatus.set(e.taskId, e.newStatus)
      }
    }
    const incomplete = Array.from(latestStatus.values()).filter((s) =>
      isIncompleteTaskStatus(s)
    ).length

    if (created > 0 && incomplete === 0) return null
  } catch {}

  if (taskToolUsed) return null

  if (toolCallCount >= TOOL_CALL_THRESHOLD) {
    const planSteps = [
      "Use TaskCreate to create one task for each significant piece of work",
      "Use TaskUpdate to mark each task completed after recording the work",
    ]
    if (sessionId) await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
    return blockStopObj(
      `No completed tasks on record (${toolCallCount} tool calls made).\n\n` +
        "Create tasks to record the work done.\n\n" +
        formatActionPlan(planSteps, { translateToolNames: true })
    )
  }
  return null
}

/** Search sibling sessions (by transcript) for CI evidence. */
async function findCiEvidenceInSiblings(
  transcript: string,
  sessionId: string,
  home: string
): Promise<boolean> {
  const siblingIds = await findProjectSessionIds(transcript, sessionId)
  for (const sibId of siblingIds) {
    const sibTasks = await readSessionTasks(sibId, home)
    if (anyTaskHasCiEvidence(sibTasks)) return true
  }
  return false
}

/** Fallback: scan all task directories for CI evidence. */
async function findCiEvidenceInAllSessions(sessionId: string, home: string): Promise<boolean> {
  const tasksRoot = getTasksRoot(home)
  if (!tasksRoot) return false
  try {
    const taskSessionIds = await readdir(tasksRoot)
    for (const sibId of taskSessionIds) {
      if (sibId === sessionId) continue
      const sibTasks = await readSessionTasks(sibId, home)
      if (anyTaskHasCiEvidence(sibTasks)) return true
    }
  } catch {
    // Ignore unreadable task roots; CI evidence check will fail closed.
  }
  return false
}

function deriveToolCallStats(summary: TranscriptSummary): {
  total: number
  taskToolUsed: boolean
} {
  const stats = deriveCurrentSessionTaskToolStats(summary.toolNames)
  return {
    total: stats.totalToolCalls,
    taskToolUsed: stats.taskToolUsed,
  }
}

async function countToolCalls(
  source: string | Record<string, any>
): Promise<{ total: number; taskToolUsed: boolean }> {
  const stats = await getCurrentSessionTaskToolStats(source)
  return {
    total: stats.totalToolCalls,
    taskToolUsed: stats.taskToolUsed,
  }
}

async function blockNoTasks(
  toolCallCount: number,
  sessionId?: string,
  cwd?: string
): Promise<SwizHookOutput> {
  const planSteps = [
    "Use TaskCreate to create one task for each significant piece of work",
    "Use TaskUpdate to mark each task completed after recording the work",
  ]
  if (sessionId) await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
  return blockStopObj(
    `No tasks were created this session (${toolCallCount} tool calls made).\n\n` +
      "Create tasks to record the work done.\n\n" +
      formatActionPlan(planSteps, { translateToolNames: true })
  )
}

/** Returns a block payload or null when stop may proceed. */
async function handleNoTasksDir(
  taskToolUsed: boolean,
  toolCallCount: number,
  sessionId?: string,
  cwd?: string
): Promise<SwizHookOutput | null> {
  if (taskToolUsed) return null
  if (toolCallCount >= TOOL_CALL_THRESHOLD) return await blockNoTasks(toolCallCount, sessionId, cwd)
  return null
}

async function enforceCiEvidence(
  allTasks: TaskFile[],
  transcript: string,
  sessionId: string,
  home: string,
  summary: TranscriptSummary | null
): Promise<SwizHookOutput | null> {
  const effectiveSummary = summary ?? (await computeTranscriptSummary(transcript))
  if (!(effectiveSummary?.hasGitPush ?? false)) return null

  let hasCiEvidence = anyTaskHasCiEvidence(allTasks)
  if (!hasCiEvidence) hasCiEvidence = await findCiEvidenceInSiblings(transcript, sessionId, home)
  if (!hasCiEvidence) hasCiEvidence = await findCiEvidenceInAllSessions(sessionId, home)

  if (!hasCiEvidence) {
    const planSteps = [
      'Create a "Push and verify CI" task and mark it in_progress.',
      "Run CI verification: swiz ci-wait <SHA> or gh run view --json conclusion.",
      "Mark the task completed via TaskUpdate (status completed), recording evidence such as: note:CI green — conclusion: success, run <run-id>",
    ]
    if (sessionId) await mergeActionPlanIntoTasks(planSteps, sessionId)
    return blockStopObj(
      "All tasks are completed but none have CI verification evidence.\n\n" +
        "The push+CI lifecycle rule requires a completed task with evidence " +
        "confirming CI passed (e.g. 'CI green', 'conclusion: success').\n\n" +
        formatActionPlan(planSteps, { translateToolNames: true })
    )
  }
  return null
}

async function resolveToolCallStats(
  raw: Record<string, any>,
  summary: TranscriptSummary | null,
  transcript: string
): Promise<{ total: number; taskToolUsed: boolean }> {
  if (summary) return deriveToolCallStats(summary)
  if (transcript) return await countToolCalls(raw)
  return { total: 0, taskToolUsed: false }
}

interface CiEvidenceAfterPushCtx {
  cwd: string
  sessionId: string
  transcript: string
  home: string
  summary: TranscriptSummary | null
  allTasks: TaskFile[]
}

async function maybeEnforceCiEvidenceAfterPush(
  ctx: CiEvidenceAfterPushCtx
): Promise<SwizHookOutput | null> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(ctx.cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, ctx.sessionId, projectSettings)
  if (effective.ignoreCi) return null
  return await enforceCiEvidence(ctx.allTasks, ctx.transcript, ctx.sessionId, ctx.home, ctx.summary)
}

async function runStopCompletionWhenTasksDirReady(opts: {
  raw: Record<string, any>
  input: StopHookInput
  sessionId: string
  transcript: string
  home: string
  tasksDir: string
}): Promise<SwizHookOutput> {
  const { raw, input, sessionId, transcript, home, tasksDir } = opts
  const summary = getTranscriptSummary(raw)
  const { total: toolCallCount, taskToolUsed } = await resolveToolCallStats(
    raw,
    summary,
    transcript
  )

  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists = allTasks.length > 0 || (await hasSessionTasksDir(sessionId, home))

  if (!tasksDirExists) {
    const block = await handleNoTasksDir(
      taskToolUsed,
      toolCallCount,
      sessionId,
      input.cwd ?? process.cwd()
    )
    return block ?? {}
  }

  if (allTasks.length === 0) {
    const block = await checkAuditLogAllowsStop(
      tasksDir,
      taskToolUsed,
      toolCallCount,
      sessionId,
      input.cwd ?? process.cwd()
    )
    return block ?? {}
  }

  // Incomplete-task blocking is handled by stop-incomplete-tasks.ts (higher priority).
  // This hook only enforces CI evidence and "no tasks created" checks.
  const hasIncomplete = allTasks.some(
    (t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status)
  )
  if (hasIncomplete) return {}

  if (transcript) {
    const block = await maybeEnforceCiEvidenceAfterPush({
      cwd: input.cwd ?? process.cwd(),
      sessionId,
      transcript,
      home,
      summary,
      allTasks,
    })
    if (block) return block
  }
  return {}
}

export async function evaluateStopCompletionAuditor(input: StopHookInput): Promise<SwizHookOutput> {
  const raw = input as Record<string, any>
  const parsed = stopHookInputSchema.parse(raw)
  const sessionId = parsed.session_id ?? ""
  const transcript = parsed.transcript_path ?? ""
  const home = getHomeDirOrNull()
  if (!home) return {}
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return {}

  return await runStopCompletionWhenTasksDirReady({
    raw,
    input: parsed,
    sessionId,
    transcript,
    home,
    tasksDir,
  })
}

const stopCompletionAuditor: SwizStopHook = {
  name: "stop-completion-auditor",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopCompletionAuditor(input)
  },
}

export default stopCompletionAuditor

if (import.meta.main) {
  await runSwizHookAsMain(stopCompletionAuditor)
}
