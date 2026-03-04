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
  isIncompleteTaskStatus,
  limitItems,
  readSessionTasks,
  type SessionHookInput,
  type SessionTask,
} from "./hook-utils.ts"
import type { CompactSnapshot } from "./precompact-task-snapshot.ts"

const TASK_PREVIEW_LIMIT = 3

function overflowLine(remaining: number, label: string): string {
  return remaining > 0 ? `\n  ... ${remaining} more ${label}` : ""
}

/**
 * Read the compact snapshot for a session if it exists.
 * Returns null when the snapshot file is absent or unreadable.
 */
async function readCompactSnapshot(
  sessionId: string,
  home: string
): Promise<CompactSnapshot | null> {
  const snapshotPath = join(home, ".claude", "tasks", sessionId, "compact-snapshot.json")
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
  const tasksDir = join(home, ".claude", "tasks", sessionId)
  const taskPath = join(tasksDir, `${snap.id}.json`)
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
  const input = (await Bun.stdin.json()) as SessionHookInput
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  let ctx =
    "Post-compaction context: Always use rg instead of grep. Use Edit tool, not sed/awk. " +
    "Do not co-author commits. Never disable code checks or quality gates. " +
    "Run git diff after reaching success."

  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? ""
  const home = process.env.HOME ?? ""

  // Verify task files against the compact snapshot (if one exists).
  // The snapshot was written by precompact-task-snapshot.ts immediately before
  // compaction triggered, so it is the authoritative record of task state at
  // that moment. Recreate any missing task files so the agent can reference
  // them by ID without manually re-entering them.
  const snapshot = sessionId ? await readCompactSnapshot(sessionId, home) : null
  const recreated: string[] = []
  if (snapshot && snapshot.tasks.length > 0) {
    const existingTasks = await readSessionTasks(sessionId, home)
    const existingIds = new Set(existingTasks.map((t) => t.id))
    for (const snap of snapshot.tasks) {
      if (!existingIds.has(snap.id)) {
        await recreateTaskFile(sessionId, home, snap)
        recreated.push(`#${snap.id} [${snap.status}]: ${snap.subject}`)
      }
    }
    if (recreated.length > 0) {
      const { visible, remaining } = limitItems(recreated, TASK_PREVIEW_LIMIT)
      ctx +=
        `\n\nCompact snapshot restored ${recreated.length} missing task file(s):\n` +
        visible.map((r) => `  • ${r}`).join("\n") +
        overflowLine(remaining, "restored task file(s)") +
        `\n\nThese task files were recreated from the pre-compaction snapshot. ` +
        `Verify their status reflects reality and update as needed.`
    }
  }

  // Surface current session's incomplete tasks — these survive compaction on disk
  // but the agent loses awareness of them when context resets.
  const currentTasks = await readSessionTasks(sessionId, home)
  const currentIncomplete = currentTasks.filter((t) => isIncompleteTaskStatus(t.status))
  if (currentIncomplete.length > 0) {
    ctx +=
      `\n\nThis session has ${currentIncomplete.length} incomplete task(s) that survived compaction:\n` +
      formatTaskList(currentIncomplete, {
        limit: TASK_PREVIEW_LIMIT,
        overflowLabel: "incomplete task(s)",
      }) +
      `\n\nIMPORTANT: Complete or update these tasks using TaskUpdate — do NOT create new tasks ` +
      `for the same work. The stop hook will block until every task in this session is completed. ` +
      `If the work described by a task is already done, mark it completed immediately.`
  }

  // Also check prior sessions for incomplete tasks (if current session has none)
  if (currentIncomplete.length === 0) {
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const completeHint = formatTaskCompleteCommand("<id>", priorSessionId, "note:done")
      ctx +=
        `\n\nPrior session (${priorSessionId}) has ${priorTasks.length} incomplete task(s). ` +
        `If already done, run: ${completeHint}\n` +
        `Otherwise continue these before creating new tasks:\n` +
        formatTaskList(priorTasks, {
          limit: TASK_PREVIEW_LIMIT,
          overflowLabel: "incomplete task(s)",
        })
    }
  }

  emitContext("SessionStart", ctx)
}

main()
