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
import { promoteNextTaskFromIssues } from "../../src/tasks/task-service.ts"
import { sessionTaskSentinelPath } from "../../src/temp-paths.ts"
import {
  deduplicateStaleTasks,
  getIncompleteDetails,
} from "../../src/utils/stop-incomplete-tasks-core.ts"
import { buildIncompleteBlockOutput, buildSoleDeferralSteeringOutput } from "./action-plan.ts"
import { resolveTaskCheckContext } from "./context.ts"
import {
  filterBlockingIncomplete,
  filterIncompleteStatus,
  stripDeferralPrefix,
} from "./incomplete-check-validator.ts"

const SHIP_CHECKLIST_SENTINEL_KEY = "stop-ship-checklist-task-created"

async function hasShipChecklistSentinel(sessionId: string): Promise<boolean> {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  if (!safeSession) return false
  const path = sessionTaskSentinelPath(SHIP_CHECKLIST_SENTINEL_KEY, safeSession)
  return await Bun.file(path).exists()
}

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

  // Deduplicate stale tasks against completed ones
  const completedTasks = ctx.allTasks.filter((t) => t.status === "completed")
  const incompleteTasks = filterIncompleteStatus(ctx.allTasks)

  if (ctx.tasksDir) {
    await deduplicateStaleTasks(completedTasks, incompleteTasks, ctx.tasksDir, true, ctx.sessionId)
  }

  // Re-filter after deduplication
  const remainingIncomplete = filterIncompleteStatus(ctx.allTasks)
  if (remainingIncomplete.length === 0) {
    // Zero incomplete tasks is normally a governance violation — promote a successor
    // so the agent always exits with a task buffer. Exception: when the ship checklist
    // was the only task source for this session (sentinel exists) and all those tasks
    // are now complete, promotion creates an unrelated issue task and loops forever.
    // In that terminal state, allow stop rather than manufacturing synthetic work.
    if (await hasShipChecklistSentinel(ctx.sessionId)) return {}

    const cwdInput = (input as Record<string, unknown>).cwd
    const cwd = typeof cwdInput === "string" ? cwdInput : undefined
    const promoted = await promoteNextTaskFromIssues(ctx.sessionId, cwd)
    if (promoted) {
      const promotedMessage = taskListAvailable
        ? "Auto-promoted task created — zero incomplete tasks is a governance violation. Run TaskList to see the promoted task."
        : "Auto-promoted task created — zero incomplete tasks is a governance violation. Use the current planning surface to adopt the promoted task before continuing."
      return buildIncompleteBlockOutput([promotedMessage], {
        tasksDir: ctx.tasksDir,
        sessionId: ctx.sessionId,
        taskListAvailable,
        taskListToolName,
        taskUpdateToolName,
      })
    }
    // Promotion failed (no issue candidates, no fallback) — allow stop as last resort
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
