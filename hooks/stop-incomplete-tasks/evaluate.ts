/**
 * Main orchestration module for stop-incomplete-tasks.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import { isCurrentAgent } from "../../src/agent-paths.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  deduplicateStaleTasks,
  getIncompleteDetails,
} from "../../src/utils/stop-incomplete-tasks-core.ts"
import { buildIncompleteBlockOutput } from "./action-plan.ts"
import { resolveTaskCheckContext } from "./context.ts"
import { filterIncompleteStatus } from "./incomplete-check-validator.ts"

/**
 * Evaluate incomplete tasks and return blocking output or empty object.
 */
export async function evaluateStopIncompleteTasks(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolveTaskCheckContext(input)
  if (!ctx) return {}

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
  if (remainingIncomplete.length === 0) return {}

  // Build block output
  const taskDetails = getIncompleteDetails(ctx.allTasks)
  return buildIncompleteBlockOutput(taskDetails)
}
