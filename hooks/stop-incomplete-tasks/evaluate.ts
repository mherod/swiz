/**
 * Main orchestration module for stop-incomplete-tasks.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import {
  agentHasTaskListToolForHookPayload,
  agentHasTaskToolsForHookPayload,
  isCurrentAgent,
  taskToolNameForHookPayload,
} from "../../src/agent-paths.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { getIncompleteDetails } from "../../src/utils/stop-incomplete-tasks-core.ts"
import { buildIncompleteBlockOutput, buildSoleDeferralSteeringOutput } from "./action-plan.ts"
import { resolveTaskCheckContext } from "./context.ts"
import {
  filterBlockingIncomplete,
  filterIncompleteStatus,
  stripDeferralPrefix,
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
  const taskListAvailable = agentHasTaskListToolForHookPayload(input as Record<string, any>)
  const taskListToolName = taskToolNameForHookPayload(input as Record<string, any>, "TaskList")
  const taskUpdateToolName = taskToolNameForHookPayload(input as Record<string, any>, "TaskUpdate")

  const remainingIncomplete = filterIncompleteStatus(ctx.allTasks)
  if (remainingIncomplete.length === 0) {
    return {}
  }

  const blockingIncomplete = filterBlockingIncomplete(ctx.allTasks)
  if (blockingIncomplete.length === 0) {
    // Edge case: having deferred tasks as the sole remaining tasks. That is
    // likely a dodge — the agent parked real work under a "Future:" label instead
    // of completing it. Steer back to the actual work.
    if (remainingIncomplete.length > 0) {
      const subjects = remainingIncomplete
        .map((t) => t.subject ?? "")
        .map((s) => stripDeferralPrefix(s) || s)
      return buildSoleDeferralSteeringOutput(subjects)
    }
    return {}
  }

  // Build block output — list all incomplete tasks so the agent knows to complete everything.
  const taskDetails = getIncompleteDetails(ctx.allTasks)
  return buildIncompleteBlockOutput(taskDetails, {
    tasksDir: ctx.tasksDir,
    sessionId: ctx.sessionId,
    taskListAvailable,
    taskListToolName,
    taskUpdateToolName,
  })
}
