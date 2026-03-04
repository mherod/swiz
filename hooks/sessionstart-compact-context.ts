#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.
// Also reads the compact-snapshot.json written by precompact-task-snapshot.ts to verify
// and recreate any task files that may be missing after compaction.

import { join } from "node:path"
import {
  emitContext,
  findPriorSessionTasks,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionHookInput,
  type SessionTask,
} from "./hook-utils.ts"
import type { CompactSnapshot } from "./precompact-task-snapshot.ts"

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
    "Post-compaction context: Always use rg instead of grep. Always use Edit tool, never sed/awk. " +
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
      ctx +=
        `\n\nCompact snapshot restored ${recreated.length} missing task file(s):\n` +
        recreated.map((r) => `  • ${r}`).join("\n") +
        `\n\nThese task files were recreated from the pre-compaction snapshot. ` +
        `Verify their status reflects reality and update as needed.`
    }
  }

  // Surface current session's incomplete tasks — these survive compaction on disk
  // but the agent loses awareness of them when context resets.
  const currentTasks = await readSessionTasks(sessionId, home)
  const currentIncomplete = currentTasks.filter((t) => isIncompleteTaskStatus(t.status))
  if (currentIncomplete.length > 0) {
    const taskLines = currentIncomplete
      .map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`)
      .join("\n")
    ctx +=
      `\n\nThis session has ${currentIncomplete.length} incomplete task(s) that survived compaction:\n` +
      taskLines +
      `\n\nIMPORTANT: Complete or update these tasks using TaskUpdate — do NOT create new tasks ` +
      `for the same work. The stop hook will block until every task in this session is completed. ` +
      `If the work described by a task is already done, mark it completed immediately.`
  }

  // Also check prior sessions for incomplete tasks (if current session has none)
  if (currentIncomplete.length === 0) {
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const taskLines = priorTasks.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
      const completeHint = priorTasks
        .map(
          (t) => `  swiz tasks complete ${t.id} --session ${priorSessionId} --evidence "note:done"`
        )
        .join("\n")
      ctx +=
        `\n\nPrior session (${priorSessionId}) had ${priorTasks.length} incomplete task(s). ` +
        `If already done, complete them:\n${completeHint}\n` +
        `Otherwise continue these instead of creating new tasks:\n` +
        taskLines
    }
  }

  emitContext("SessionStart", ctx)
}

main()
