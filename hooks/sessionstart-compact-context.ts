#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.
// Also reads the compact-snapshot.json written by precompact-task-snapshot.ts to verify
// and recreate any task files that may be missing after compaction.

import { join } from "node:path"
import {
  emitContext,
  findPriorSessionTasks,
  formatTaskCompleteCommand,
  formatTaskList,
  getSessionTaskPath,
  getSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionTask,
} from "./hook-utils.ts"
import {
  buildCompactSnapshotSummary,
  type CompactSnapshot,
  type CompactSnapshotSummary,
} from "./precompact-task-snapshot.ts"
import { sessionHookInputSchema } from "./schemas.ts"

const TASK_PREVIEW_LIMIT = 3
const TASK_SUBJECT_MAX_CHARS = 120
const COMPACT_CONTEXT_MAX_CHARS = 2400
const BUDGET_TRUNCATION_NOTE = "[Compaction context truncated to stay within budget.]"

function summarizeSnapshot(snapshot: CompactSnapshot): CompactSnapshotSummary {
  return snapshot.summary ?? buildCompactSnapshotSummary(snapshot.tasks)
}

function renderSnapshotSummary(snapshot: CompactSnapshot): string {
  const summary = summarizeSnapshot(snapshot)
  const lines = [
    `Compaction summary: ${summary.completedCount} completed, ${summary.incompleteCount} incomplete before compaction.`,
  ]

  if (summary.completedHighlights.length > 0) {
    lines.push(`Completed: ${summary.completedHighlights.join("; ")}`)
  }
  if (summary.openDecisions.length > 0) {
    lines.push(`Open decisions: ${summary.openDecisions.join("; ")}`)
  }
  if (summary.nextActions.length > 0) {
    lines.push(`Next actions: ${summary.nextActions.join("; ")}`)
  }

  return lines.join("\n")
}

function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const marker = `\n\n${BUDGET_TRUNCATION_NOTE}`
  if (maxChars <= marker.length + 3) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - marker.length - 3)}...${marker}`
}

function joinSectionsWithinBudget(sections: string[], maxChars: number): string {
  let out = ""
  for (const section of sections) {
    const next = out ? `${out}\n\n${section}` : section
    if (next.length <= maxChars) {
      out = next
      continue
    }

    const spacerLength = out ? 2 : 0
    const remaining = maxChars - out.length - spacerLength
    if (remaining > 0) {
      const truncatedSection = truncateToBudget(section, remaining)
      out = out ? `${out}\n\n${truncatedSection}` : truncatedSection
    }
    break
  }
  return out
}

/**
 * Read the compact snapshot for a session if it exists.
 * Returns null when the snapshot file is absent or unreadable.
 */
async function readCompactSnapshot(
  sessionId: string,
  home: string
): Promise<CompactSnapshot | null> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null
  const snapshotPath = join(tasksDir, "compact-snapshot.json")
  try {
    const file = Bun.file(snapshotPath)
    if (!(await file.exists())) return null
    return (await file.json()) as CompactSnapshot
  } catch {
    return null
  }
}

/**
 * Recreate a missing task file from snapshot data.
 * Only called when the task JSON file is absent but the snapshot says it should exist.
 */
async function recreateTaskFile(
  sessionId: string,
  home: string,
  snap: CompactSnapshot["tasks"][number]
): Promise<void> {
  const taskPath = getSessionTaskPath(sessionId, snap.id, home)
  if (!taskPath) return
  const task: Partial<SessionTask> & { id: string; subject: string; status: string } = {
    id: snap.id,
    subject: snap.subject,
    status: snap.status,
    blocks: [],
    blockedBy: [],
    ...(snap.activeForm ? { activeForm: snap.activeForm } : {}),
    ...(snap.description ? { description: snap.description } : {}),
  }
  await Bun.write(taskPath, JSON.stringify(task, null, 2))
}

async function main(): Promise<void> {
  const input = sessionHookInputSchema.parse(await Bun.stdin.json())
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  const sections: string[] = []
  sections.push(
    "Post-compaction context: Always use rg instead of grep. Use Edit tool, not sed/awk. " +
      "Do not co-author commits. Never disable code checks or quality gates. " +
      "Run git diff after reaching success."
  )

  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? ""
  const home = process.env.HOME ?? ""

  // Verify task files against the compact snapshot (if one exists).
  // The snapshot was written by precompact-task-snapshot.ts immediately before
  // compaction triggered, so it is the authoritative record of task state at
  // that moment. Recreate any missing task files so the agent can reference
  // them by ID without manually re-entering them.
  const snapshot = sessionId ? await readCompactSnapshot(sessionId, home) : null
  if (snapshot && snapshot.tasks.length > 0) {
    sections.push(renderSnapshotSummary(snapshot))
  }

  const recreated: Array<Pick<SessionTask, "id" | "status" | "subject">> = []
  if (snapshot && snapshot.tasks.length > 0) {
    const existingTasks = await readSessionTasks(sessionId, home)
    const existingIds = new Set(existingTasks.map((t) => t.id))
    for (const snap of snapshot.tasks) {
      if (!existingIds.has(snap.id)) {
        await recreateTaskFile(sessionId, home, snap)
        recreated.push({ id: snap.id, status: snap.status, subject: snap.subject })
      }
    }
    if (recreated.length > 0) {
      const restoredList = formatTaskList(recreated, {
        limit: TASK_PREVIEW_LIMIT,
        overflowLabel: "restored task file(s)",
        subjectMaxLength: TASK_SUBJECT_MAX_CHARS,
      })
      sections.push(
        `Compact snapshot restored ${recreated.length} missing task file(s):\n` +
          restoredList +
          `\n\nThese task files were recreated from the pre-compaction snapshot. ` +
          `Verify their status reflects reality and update as needed.`
      )
    }
  }

  // Surface current session's incomplete tasks — these survive compaction on disk
  // but the agent loses awareness of them when context resets.
  const currentTasks = await readSessionTasks(sessionId, home)
  const currentIncomplete = currentTasks.filter((t) => isIncompleteTaskStatus(t.status))
  if (currentIncomplete.length > 0) {
    sections.push(
      `This session has ${currentIncomplete.length} incomplete task(s) that survived compaction:\n` +
        formatTaskList(currentIncomplete, {
          limit: TASK_PREVIEW_LIMIT,
          overflowLabel: "incomplete task(s)",
          subjectMaxLength: TASK_SUBJECT_MAX_CHARS,
        }) +
        `\n\nIMPORTANT: Complete or update these tasks using TaskUpdate — do NOT create new tasks ` +
        `for the same work. The stop hook will block until every task in this session is completed. ` +
        `If the work described by a task is already done, mark it completed immediately.`
    )
  }

  // Also check prior sessions for incomplete tasks (if current session has none)
  if (currentIncomplete.length === 0) {
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const completeHint = formatTaskCompleteCommand("<id>", priorSessionId, "note:done")
      sections.push(
        `Prior session (${priorSessionId}) has ${priorTasks.length} incomplete task(s). ` +
          `If already done, run: ${completeHint}\n` +
          `Otherwise continue these before creating new tasks:\n` +
          formatTaskList(priorTasks, {
            limit: TASK_PREVIEW_LIMIT,
            overflowLabel: "incomplete task(s)",
            subjectMaxLength: TASK_SUBJECT_MAX_CHARS,
          })
      )
    }
  }

  const ctx = joinSectionsWithinBudget(sections, COMPACT_CONTEXT_MAX_CHARS)
  emitContext("SessionStart", ctx)
}

main()
