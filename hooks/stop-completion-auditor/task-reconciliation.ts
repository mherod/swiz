/**
 * Task Reconciliation Module
 *
 * Coordinates task state by:
 * - Waiting for task directory to be ready
 * - Reading fresh task files from disk
 * - Handling stale task state reconciliation
 * - Preparing context for all validators
 */

import { isIncompleteTaskStatus } from "../../src/tasks/task-recovery.ts"
import { isTaskListTool } from "../../src/tool-matchers.ts"
import { getCurrentSessionTaskToolStats } from "../../src/utils/hook-utils.ts"
import type { CompletionAuditContext, ValidationResult } from "./types.ts"

/**
 * Verify all tasks are synced by requiring TaskList to have been called.
 * Prevents stale task cache from blocking stop with incorrect information.
 */
export function requireTaskListSync(ctx: CompletionAuditContext): ValidationResult | null {
  // Skip if no tasks exist yet
  if (ctx.allTasks.length === 0) return null

  // Skip if TaskList was already called this session
  if (ctx.observedToolNames.some((n) => isTaskListTool(n))) return null

  // Block stop and require TaskList sync
  return {
    kind: "task-creation",
    reason:
      "Call TaskList before stopping to sync task state.\n\n" +
      "Tasks exist but TaskList was never called this session. " +
      "Run TaskList now, then retry stop.",
  }
}

/**
 * Check if any tasks are incomplete.
 * Incomplete-task blocking is handled by stop-incomplete-tasks.ts (higher priority).
 * This function just reports the state.
 */
export function hasIncompleteTask(ctx: CompletionAuditContext): boolean {
  return ctx.allTasks.some((t) => t.id && t.id !== "null" && isIncompleteTaskStatus(t.status))
}

/**
 * Resolve tool call statistics from transcript.
 * Falls back to counting from raw input if transcript unavailable.
 */
export async function resolveToolCallStats(
  raw: Record<string, any>,
  transcript: string
): Promise<{ total: number; taskToolUsed: boolean; toolNames: string[] }> {
  try {
    const stats = await getCurrentSessionTaskToolStats(transcript || raw)
    return {
      total: stats.totalToolCalls,
      taskToolUsed: stats.taskToolUsed,
      toolNames: stats.toolNames,
    }
  } catch {
    return { total: 0, taskToolUsed: false, toolNames: [] }
  }
}
