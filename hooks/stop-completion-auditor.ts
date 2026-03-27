#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { orderBy } from "lodash-es"
import { getHomeDirOrNull } from "../src/home.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  computeSubjectFingerprint,
  computeTranscriptSummary,
  deriveCurrentSessionTaskToolStats,
  formatActionPlan,
  getCurrentSessionTaskToolStats,
  getSessionTasksDir,
  getTasksRoot,
  getTranscriptSummary,
  hasSessionTasksDir,
  isIncompleteTaskStatus,
  normalizeSubject,
  readSessionTasks,
  type SessionTask,
  subjectsOverlap,
  type TranscriptSummary,
} from "./utils/hook-utils.ts"

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
    // Transition through in_progress if pending, to satisfy lifecycle
    if (stale.status === "pending") stale.status = "in_progress"
    const updated = {
      ...stale,
      status: "completed" as const,
      completionEvidence: "note:auto-completed — duplicate of a completed task",
    }
    await Bun.write(taskPath, JSON.stringify(updated, null, 2))
    stale.status = "completed"
  } catch {
    // Write failed — leave as-is and let the normal block message fire
  }
}

/** Auto-complete stale incomplete tasks that are duplicates of completed ones. */
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

/** Check audit log when no live task files exist; returns true if stop is allowed. */
async function checkAuditLogAllowsStop(
  tasksDir: string,
  taskToolUsed: boolean,
  toolCallCount: number
): Promise<boolean> {
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

    if (created > 0 && incomplete === 0) return true
  } catch {}

  if (taskToolUsed) return true

  if (toolCallCount >= TOOL_CALL_THRESHOLD) {
    blockStop(
      `No completed tasks on record (${toolCallCount} tool calls made).\n\n` +
        "Create tasks to record the work done.\n\n" +
        formatActionPlan(
          [
            "Use TaskCreate to create one task for each significant piece of work",
            "Use TaskUpdate to mark each task completed after recording the work",
          ],
          { translateToolNames: true }
        )
    )
  }
  return true
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
  source: string | Record<string, unknown>
): Promise<{ total: number; taskToolUsed: boolean }> {
  const stats = await getCurrentSessionTaskToolStats(source)
  return {
    total: stats.totalToolCalls,
    taskToolUsed: stats.taskToolUsed,
  }
}

function blockNoTasks(toolCallCount: number): void {
  blockStop(
    `No tasks were created this session (${toolCallCount} tool calls made).\n\n` +
      "Create tasks to record the work done.\n\n" +
      formatActionPlan(
        [
          "Use TaskCreate to create one task for each significant piece of work",
          "Use TaskUpdate to mark each task completed after recording the work",
        ],
        { translateToolNames: true }
      )
  )
}

/** Returns true if stop should proceed, false if blocked. */
function handleNoTasksDir(taskToolUsed: boolean, toolCallCount: number): boolean {
  if (taskToolUsed) return true
  if (toolCallCount >= TOOL_CALL_THRESHOLD) blockNoTasks(toolCallCount)
  return true
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

function blockIncompleteTasks(incompleteDetails: string[]): void {
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

async function enforceCiEvidence(
  allTasks: TaskFile[],
  transcript: string,
  sessionId: string,
  home: string,
  summary: TranscriptSummary | null
): Promise<void> {
  const effectiveSummary = summary ?? (await computeTranscriptSummary(transcript))
  if (!(effectiveSummary?.hasGitPush ?? false)) return

  let hasCiEvidence = anyTaskHasCiEvidence(allTasks)
  if (!hasCiEvidence) hasCiEvidence = await findCiEvidenceInSiblings(transcript, sessionId, home)
  if (!hasCiEvidence) hasCiEvidence = await findCiEvidenceInAllSessions(sessionId, home)

  if (!hasCiEvidence) {
    blockStop(
      "All tasks are completed but none have CI verification evidence.\n\n" +
        "The push+CI lifecycle rule requires a completed task with evidence " +
        "confirming CI passed (e.g. 'CI green', 'conclusion: success').\n\n" +
        formatActionPlan(
          [
            'Create a "Push and verify CI" task and mark it in_progress.',
            "Run CI verification: swiz ci-wait <SHA> or gh run view --json conclusion.",
            'Mark the task completed: swiz tasks complete <id> --evidence "note:CI green — conclusion: success, run <run-id>"',
          ],
          { translateToolNames: true }
        )
    )
  }
}

async function resolveToolCallStats(
  raw: Record<string, unknown>,
  summary: TranscriptSummary | null,
  transcript: string
): Promise<{ total: number; taskToolUsed: boolean }> {
  if (summary) return deriveToolCallStats(summary)
  if (transcript) return await countToolCalls(raw)
  return { total: 0, taskToolUsed: false }
}

async function filterAndDeduplicateTasks(
  allTasks: TaskFile[],
  tasksDir: string
): Promise<{ completedTasks: TaskFile[]; incompleteTasks: TaskFile[] }> {
  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status)
  )
  await deduplicateStaleTasks(completedTasks, incompleteTasks, tasksDir)
  return { completedTasks, incompleteTasks }
}

interface CiEvidenceAfterPushCtx {
  cwd: string
  sessionId: string
  transcript: string
  home: string
  summary: TranscriptSummary | null
  allTasks: TaskFile[]
}

async function maybeEnforceCiEvidenceAfterPush(ctx: CiEvidenceAfterPushCtx): Promise<void> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(ctx.cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, ctx.sessionId, projectSettings)
  if (effective.ignoreCi) return
  await enforceCiEvidence(ctx.allTasks, ctx.transcript, ctx.sessionId, ctx.home, ctx.summary)
}

async function runStopCompletionWhenTasksDirReady(opts: {
  raw: Record<string, unknown>
  input: StopHookInput
  sessionId: string
  transcript: string
  home: string
  tasksDir: string
}): Promise<void> {
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
    handleNoTasksDir(taskToolUsed, toolCallCount)
    return
  }

  if (allTasks.length === 0) {
    await checkAuditLogAllowsStop(tasksDir, taskToolUsed, toolCallCount)
    return
  }

  await filterAndDeduplicateTasks(allTasks, tasksDir)

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length > 0) {
    blockIncompleteTasks(incompleteDetails)
    return
  }

  if (transcript) {
    await maybeEnforceCiEvidenceAfterPush({
      cwd: input.cwd ?? process.cwd(),
      sessionId,
      transcript,
      home,
      summary,
      allTasks,
    })
  }
}

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = stopHookInputSchema.parse(raw)
  const sessionId = input.session_id ?? ""
  const transcript = input.transcript_path ?? ""
  const home = getHomeDirOrNull()
  if (!home) return
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return

  await runStopCompletionWhenTasksDirReady({
    raw,
    input,
    sessionId,
    transcript,
    home,
    tasksDir,
  })
}

if (import.meta.main) {
  void main()
}
