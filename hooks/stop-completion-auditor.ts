#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { orderBy } from "lodash-es"
import { getHomeDirOrNull } from "../src/home.ts"
import { stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  computeSubjectFingerprint,
  computeTranscriptSummary,
  extractToolNamesFromTranscript,
  formatActionPlan,
  getSessionTasksDir,
  getTasksRoot,
  getTranscriptSummary,
  hasSessionTasksDir,
  isTaskCreateTool,
  readSessionTasks,
  type SessionTask,
  type TranscriptSummary,
} from "./utils/hook-utils.ts"

const TOOL_CALL_THRESHOLD = 10

// ── Subject deduplication helpers ──────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace for fuzzy comparison. */
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Extract significant words (skip stop words and short tokens). */
export function significantWords(normalized: string): Set<string> {
  const STOP = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "to",
    "in",
    "of",
    "on",
    "with",
    "is",
    "was",
    "be",
  ])
  return new Set(normalized.split(" ").filter((w) => w.length > 2 && !STOP.has(w)))
}

/**
 * Two subjects overlap if they share ≥50% of their significant words.
 * This catches cases like "Push backward-compat error commit" vs
 * "Push backward-compat commit" without false-positiving on unrelated tasks.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = significantWords(a)
  const wordsB = significantWords(b)
  if (wordsA.size === 0 || wordsB.size === 0) return false
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  const minSize = Math.min(wordsA.size, wordsB.size)
  return overlap / minSize >= 0.5
}

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
    const staleFp = stale.subjectFingerprint ?? computeSubjectFingerprint(stale.subject)
    let isDuplicate = completedFingerprints.has(staleFp)
    if (!isDuplicate) {
      const staleNorm = normalizeSubject(stale.subject)
      isDuplicate = completedNormalized.some((cs) => subjectsOverlap(staleNorm, cs))
    }
    if (!isDuplicate) continue
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
    const incomplete = Array.from(latestStatus.values()).filter(
      (s) => s === "pending" || s === "in_progress"
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
  return {
    total: summary.toolCallCount,
    taskToolUsed: summary.toolNames.some((n) => n === "TaskUpdate" || isTaskCreateTool(n)),
  }
}

async function countToolCalls(
  transcriptPath: string
): Promise<{ total: number; taskToolUsed: boolean }> {
  const toolNames = await extractToolNamesFromTranscript(transcriptPath)
  return {
    total: toolNames.length,
    taskToolUsed: toolNames.some((n) => n === "TaskUpdate" || isTaskCreateTool(n)),
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
    .filter((t): t is TaskFile => t.status === "pending" || t.status === "in_progress")
  return orderBy(
    incompleteTaskRows,
    [(task) => (task.status === "in_progress" ? 1 : 0), (task) => Number.parseInt(task.id, 10)],
    ["desc", "asc"]
  ).map((t) => `#${t.id} [${t.status}]: ${t.subject}`)
}

function blockIncompleteTasks(incompleteDetails: string[]): void {
  const currentTaskList = formatActionPlan(incompleteDetails, { header: "Current task list:" })
  blockStop(
    "Incomplete tasks found:\n\n" +
      currentTaskList +
      "\n\n" +
      formatActionPlan(
        [
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

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = stopHookInputSchema.parse(raw)
  const sessionId = input.session_id ?? ""
  const transcript = input.transcript_path ?? ""
  const home = getHomeDirOrNull()
  if (!home) return
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return

  const summary = getTranscriptSummary(raw)
  const { total: toolCallCount, taskToolUsed } = summary
    ? deriveToolCallStats(summary)
    : transcript
      ? await countToolCalls(transcript)
      : { total: 0, taskToolUsed: false }

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

  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && (t.status === "pending" || t.status === "in_progress")
  )
  await deduplicateStaleTasks(completedTasks, incompleteTasks, tasksDir)

  const incompleteDetails = getIncompleteDetails(allTasks)
  if (incompleteDetails.length > 0) {
    blockIncompleteTasks(incompleteDetails)
    return
  }

  if (transcript) {
    await enforceCiEvidence(allTasks, transcript, sessionId, home, summary)
  }
}

if (import.meta.main) {
  void main()
}
