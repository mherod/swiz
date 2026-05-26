/**
 * Task Reconciliation Module
 *
 * Coordinates task state by:
 * - Waiting for task directory to be ready
 * - Reading fresh task files from disk
 * - Handling stale task state reconciliation
 * - Preparing context for all validators
 */

import { detectCurrentAgentFromHookPayload } from "../../src/agent-paths.ts"
import { isIncompleteTaskStatus } from "../../src/tasks/task-recovery.ts"
import { isTaskListTool } from "../../src/tool-matchers.ts"
import {
  formatCurrentSessionUsageWindow,
  getCurrentSessionTaskToolStats,
  getRecentToolsUsedForCurrentSession,
} from "../../src/utils/hook-utils.ts"
import type { CompletionAuditContext, ValidationResult } from "./types.ts"

/**
 * Verify all tasks are synced by requiring TaskList to have been called.
 * Prevents stale task cache from blocking stop with incorrect information.
 */
export function requireTaskListSync(
  ctx: CompletionAuditContext,
  input?: Record<string, any>
): ValidationResult | null {
  // Skip if no tasks exist yet
  if (ctx.allTasks.length === 0) return null
  // Disable the TaskList sync requirement when not running inside Claude
  const agent = detectCurrentAgentFromHookPayload(input)
  if (!agent || agent.id !== "claude") return null

  // Skip if TaskList was called recently in the current session.
  if (ctx.recentObservedToolNames.some((n) => isTaskListTool(n))) return null

  // Block stop and require TaskList sync
  return {
    kind: "task-creation",
    reason:
      "Call TaskList before stopping to sync task state.\n\n" +
      `Tasks exist but TaskList was not called recently (${formatCurrentSessionUsageWindow()}). ` +
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
): Promise<{
  total: number
  taskToolUsed: boolean
  toolNames: string[]
  recentToolNames: string[]
}> {
  const source = transcript || raw
  let total = 0
  let taskToolUsed = false
  let toolNames: string[] = []
  try {
    const stats = await getCurrentSessionTaskToolStats(source)
    total = stats.totalToolCalls
    taskToolUsed = stats.taskToolUsed
    toolNames = stats.toolNames
  } catch {
    // Keep fail-open defaults for transcript stats.
  }

  let recentToolNames: string[] = []
  try {
    recentToolNames = await getRecentToolsUsedForCurrentSession(source)
  } catch {
    // Keep fail-open defaults for recent usage.
  }

  return { total, taskToolUsed, toolNames, recentToolNames }
}
