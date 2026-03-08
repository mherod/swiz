#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  blockStop,
  computeSubjectFingerprint,
  computeTranscriptSummary,
  extractToolNamesFromTranscript,
  formatActionPlan,
  formatTaskCompleteCommands,
  getSessionTasksDir,
  getTasksRoot,
  getTranscriptSummary,
  hasSessionTasksDir,
  isTaskCreateTool,
  readSessionTasks,
  type SessionTask,
  type TranscriptSummary,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

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

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = stopHookInputSchema.parse(raw)
  const sessionId = input.session_id ?? ""
  const transcript = input.transcript_path ?? ""
  const home = getHomeDirOrNull()
  if (!home) return
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return

  // Prefer pre-computed summary from dispatch; fall back to reading transcript
  const summary = getTranscriptSummary(raw)
  const { total: toolCallCount, taskToolUsed } = summary
    ? deriveToolCallStats(summary)
    : transcript
      ? await countToolCalls(transcript)
      : { total: 0, taskToolUsed: false }

  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists = allTasks.length > 0 || (await hasSessionTasksDir(sessionId, home))

  if (!tasksDirExists) {
    // If task tools were used, tasks existed and were completed
    if (taskToolUsed) return

    // No tasks ever created — mandate if session has been substantial
    if (toolCallCount >= TOOL_CALL_THRESHOLD) {
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
    return
  }

  // Read task files
  const anyTaskFound = allTasks.length > 0

  // ── Stale-task deduplication ──────────────────────────────────────────────
  // After context compaction the agent may create a new task for work that an
  // older task already described. Use deterministic fingerprint matching as
  // the primary key; fall back to fuzzy word overlap for legacy tasks.
  const completedTasks = allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = allTasks.filter(
    (t) => t.id && t.id !== "null" && (t.status === "pending" || t.status === "in_progress")
  )

  if (completedTasks.length > 0 && incompleteTasks.length > 0) {
    // Build a set of completed fingerprints for O(1) lookup
    const completedFingerprints = new Set<string>()
    for (const t of completedTasks) {
      const fp = t.subjectFingerprint ?? computeSubjectFingerprint(t.subject)
      completedFingerprints.add(fp)
    }

    // Fuzzy fallback: precompute normalized subjects for legacy tasks without fingerprints
    const completedNormalized = completedTasks.map((t) => normalizeSubject(t.subject))

    for (const stale of incompleteTasks) {
      const staleFp = stale.subjectFingerprint ?? computeSubjectFingerprint(stale.subject)
      // Primary: exact fingerprint match
      let isDuplicate = completedFingerprints.has(staleFp)
      // Fallback: fuzzy word overlap for edge cases (e.g., minor rewording)
      if (!isDuplicate) {
        const staleNorm = normalizeSubject(stale.subject)
        isDuplicate = completedNormalized.some((cs) => subjectsOverlap(staleNorm, cs))
      }
      if (isDuplicate) {
        try {
          const taskPath = join(tasksDir, `${stale.id}.json`)
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
  }

  const incompleteDetails = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is TaskFile => t.status === "pending" || t.status === "in_progress")
    .sort((a, b) => {
      // Show actively worked tasks first, then remaining pending tasks.
      if (a.status === b.status) return 0
      if (a.status === "in_progress") return -1
      if (b.status === "in_progress") return 1
      return 0
    })
    .map((t) => `#${t.id} [${t.status}]: ${t.subject}`)

  // If no live task files found, check audit log
  if (!anyTaskFound) {
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

      // Group status changes by taskId, take latest
      const latestStatus = new Map<string, string>()
      for (const e of entries) {
        if (e.action === "status_change" && e.newStatus) {
          latestStatus.set(e.taskId, e.newStatus)
        }
      }
      const incomplete = Array.from(latestStatus.values()).filter(
        (s) => s === "pending" || s === "in_progress"
      ).length

      if (created > 0 && incomplete === 0) return // All completed
    } catch {}

    if (taskToolUsed) return

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
    return
  }

  // Block if incomplete tasks exist
  if (incompleteDetails.length > 0) {
    const incompleteTasks = allTasks.filter(
      (t) => t.id && t.id !== "null" && (t.status === "pending" || t.status === "in_progress")
    )
    const currentTaskList = formatActionPlan(incompleteDetails, { header: "Current task list:" })
    const completeCommands = formatTaskCompleteCommands(
      incompleteTasks,
      sessionId,
      "note:completed",
      { indent: "  " }
    )
    blockStop(
      "Incomplete tasks found:\n\n" +
        currentTaskList +
        "\n\n" +
        formatActionPlan(
          [
            `If the work is already done, mark the tasks complete:\n${completeCommands}`,
            "If the work is still needed, complete it before stopping.",
          ],
          { translateToolNames: true }
        )
    )
  }

  // ── CI verification enforcement ───────────────────────────────────────────
  // When all tasks are completed and the session pushed commits, at least one
  // completed task must have evidence mentioning CI verification (e.g.
  // "CI green", "conclusion: success", "CI passed"). This enforces the
  // push+CI task lifecycle rule programmatically.
  if (allTasks.length > 0 && incompleteDetails.length === 0 && transcript) {
    // Use summary if available; otherwise compute from transcript for push detection
    const effectiveSummary = summary ?? (await computeTranscriptSummary(transcript))
    const sessionPushed = effectiveSummary?.hasGitPush ?? false

    if (sessionPushed) {
      const CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i
      const completedTasks = allTasks.filter((t) => t.status === "completed")
      let hasCiEvidence = completedTasks.some(
        (t) =>
          (t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
          (t.subject && CI_EVIDENCE_RE.test(t.subject))
      )

      // Cross-session lookup: check sibling sessions from the same project
      if (!hasCiEvidence && transcript) {
        const siblingIds = await findProjectSessionIds(transcript, sessionId)
        for (const sibId of siblingIds) {
          if (hasCiEvidence) break
          const sibTasks = await readSessionTasks(sibId, home)
          hasCiEvidence = sibTasks
            .filter((t) => t.status === "completed")
            .some(
              (t) =>
                (t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
                (t.subject && CI_EVIDENCE_RE.test(t.subject))
            )
        }
      }

      // Fallback: if sibling transcript discovery misses a session for any
      // reason (older project-key layout, missing transcript file, etc.),
      // scan other task-session directories directly.
      if (!hasCiEvidence) {
        const tasksRoot = getTasksRoot(home)
        if (!tasksRoot) return
        try {
          const taskSessionIds = await readdir(tasksRoot)
          for (const sibId of taskSessionIds) {
            if (hasCiEvidence) break
            if (sibId === sessionId) continue
            const sibTasks = await readSessionTasks(sibId, home)
            hasCiEvidence = sibTasks
              .filter((t) => t.status === "completed")
              .some(
                (t) =>
                  (t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
                  (t.subject && CI_EVIDENCE_RE.test(t.subject))
              )
          }
        } catch {
          // Ignore unreadable task roots; CI evidence check will fail closed.
        }
      }

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
  }
}

if (import.meta.main) {
  main()
}
