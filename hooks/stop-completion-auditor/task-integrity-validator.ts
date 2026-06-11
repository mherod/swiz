/**
 * Task File Integrity Validator (#688)
 *
 * Closes the fabricated-completed-file bypass: an out-of-band process — another
 * session, the user's shell, an MCP server, a `Bun.spawn` child — can drop a
 * `completed` task JSON into the session directory. Because that write never
 * passed through a hooked tool call, no PostToolUse hook recorded it in the
 * session trail. The completion auditor would otherwise let stop proceed: the
 * task reads `completed`, so nothing blocks.
 *
 * Detection mirrors `swiz tasks repair`'s orphan check: a `completed` task file
 * present on disk but absent from the trail. Both legitimate write paths leave a
 * trail — native TaskCreate/TaskUpdate via `posttooluse-task-sync`, and
 * `swiz tasks` / MCP via `writeAudit` — so only an out-of-band write is missing.
 *
 * AC3 (#688): a session with no trail at all is never flagged. When the trail is
 * empty we cannot tell a fabricated file from a session that simply never
 * recorded one (e.g. the sync hook never ran), so we stay silent rather than
 * risk a false block.
 */

import { join } from "node:path"
import { agentHasTaskTools } from "../../src/agent-paths.ts"
import { getTaskToolName } from "../../src/tasks/task-governance-messages.ts"
import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import { mergeActionPlanIntoTasks } from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem, CompletionAuditContext, ValidationResult } from "./types.ts"

/** Collect the set of task IDs that appear anywhere in the session trail. */
async function readTrailTaskIds(tasksDir: string): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const text = await Bun.file(join(tasksDir, ".audit-log.jsonl")).text()
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as { taskId?: unknown }
        if (entry && entry.taskId != null) ids.add(String(entry.taskId))
      } catch {
        // skip a malformed line — a truncated write must not blind the check
      }
    }
  } catch {
    // no trail file or unreadable → empty set
  }
  return ids
}

/**
 * Pure detection: completed task files on disk with no record in the session
 * trail. Returns `[]` for every safe case — no completed files, no trail to
 * compare against (AC3), or every completed file accounted for. Side-effect
 * free so it can be unit-tested without touching real task storage.
 */
export async function detectOrphanedCompletedTasks(
  ctx: Pick<CompletionAuditContext, "gates" | "allTasks" | "tasksDir">
): Promise<SessionTask[]> {
  if (!ctx.gates.auditLog) return []

  // Only a completed file that persists on disk can carry the fabricated-state
  // bypass; live (pending/in_progress) files are handled by stop-incomplete-tasks.
  const completedOnDisk = ctx.allTasks.filter((t) => t.status === "completed")
  if (completedOnDisk.length === 0) return []

  // Require an active trail to distinguish out-of-band writes from a session that
  // never recorded one. No trail → cannot tell → stay silent (AC3).
  const trailTaskIds = await readTrailTaskIds(ctx.tasksDir)
  if (trailTaskIds.size === 0) return []

  return completedOnDisk.filter((t) => !trailTaskIds.has(t.id))
}

export async function validateTaskFileIntegrity(
  ctx: CompletionAuditContext
): Promise<ValidationResult> {
  if (!agentHasTaskTools()) return { kind: "ok" }

  const orphaned = await detectOrphanedCompletedTasks(ctx)
  if (orphaned.length === 0) return { kind: "ok" }

  const subjects = orphaned.map((t) => `#${t.id} (${t.subject})`).join(", ")
  const planSteps: ActionPlanItem[] = [
    {
      description:
        `Reconcile the completed task file(s) with no record this session — ${subjects} — ` +
        `re-do the work as a tracked task via ${getTaskToolName("TaskUpdate")} if it is genuine, ` +
        `or remove the stray file if you did not write it`,
      priority: 1,
    },
  ]

  // Give the agent a concrete task to act on before it can retry stop.
  await mergeActionPlanIntoTasks(
    planSteps.map((s) => s.description),
    ctx.sessionId,
    ctx.cwd
  )

  return {
    kind: "integrity",
    reason:
      `${orphaned.length} completed task file(s) sit on disk with no record of being worked ` +
      `this session — ${subjects}. They may have been written by another process and ` +
      `can't be trusted as done.`,
    planSteps,
  }
}
