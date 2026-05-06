/**
 * Main orchestration module for stop-incomplete-tasks.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import { agentHasTaskToolsForHookPayload, isCurrentAgent } from "../../src/agent-paths.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { promoteNextTaskFromIssues } from "../../src/tasks/task-service.ts"
import {
  deduplicateStaleTasks,
  getIncompleteDetails,
} from "../../src/utils/stop-incomplete-tasks-core.ts"
import { buildIncompleteBlockOutput } from "./action-plan.ts"
import { resolveTaskCheckContext } from "./context.ts"
import {
  filterBlockingIncomplete,
  filterIncompleteStatus,
  isDeferredSubject,
} from "./incomplete-check-validator.ts"

/**
 * Evaluate incomplete tasks and return blocking output or empty object.
 */
export async function evaluateStopIncompleteTasks(input: StopHookInput): Promise<SwizHookOutput> {
  // CLI fast path already scanned tasks and found no blockers — skip redundant disk read
  if ((input as Record<string, unknown>)._fastPathTaskScanComplete) return {}

  const ctx = await resolveTaskCheckContext(input)
  if (!ctx) return {}

  if (!agentHasTaskToolsForHookPayload(input as Record<string, any>)) return {}
  // Gemini agent exemption
  if (isCurrentAgent("gemini")) return {}

  // Deduplicate stale tasks against completed ones
  const completedTasks = ctx.allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = filterIncompleteStatus(ctx.allTasks)

  if (ctx.tasksDir) {
    await deduplicateStaleTasks(completedTasks, incompleteTasks, ctx.tasksDir, true, ctx.sessionId)
  }

  // Re-filter after deduplication
  const remainingIncomplete = filterIncompleteStatus(ctx.allTasks)
  if (remainingIncomplete.length === 0) {
    // Zero incomplete tasks is a governance violation — the task system enforces
    // ≥2 incomplete at all times. Promote a successor and block the stop so the
    // agent acts on the promoted task instead of exiting.
    const cwdInput = (input as Record<string, unknown>).cwd
    const cwd = typeof cwdInput === "string" ? cwdInput : undefined
    const promoted = await promoteNextTaskFromIssues(ctx.sessionId, cwd)
    if (promoted) {
      return buildIncompleteBlockOutput([
        "Auto-promoted task created — zero incomplete tasks is a governance violation. Run TaskList to see the promoted task.",
      ])
    }
    // Promotion failed (no issue candidates, no fallback) — allow stop as last resort
    return {}
  }

  // Deferred-subject pending tasks ("Consider ", "Future:", "Follow-up:") are
  // forward-looking notes that carry over to the next session — they satisfy
  // the planning buffer for hygiene but should not block stop. See issue #563.
  const blockingIncomplete = filterBlockingIncomplete(ctx.allTasks)
  if (blockingIncomplete.length === 0) return {}

  // Build block output — only list non-deferred tasks so the agent isn't told
  // to act on tasks that the hook has already decided to carry over.
  const taskDetails = getIncompleteDetails(ctx.allTasks).filter((line) => {
    // Lines are formatted as `${subject} (task #${id})` — strip the suffix
    // before classification so deferred subjects ending in `:` still match.
    const subject = line.replace(/\s*\(task #[^)]*\)\s*$/, "")
    return !isDeferredSubject(subject)
  })
  return buildIncompleteBlockOutput(taskDetails)
}
