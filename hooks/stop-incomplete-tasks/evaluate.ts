/**
 * Main orchestration module for stop-incomplete-tasks.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import {
  agentHasTaskListToolForHookPayload,
  agentHasTaskToolsForHookPayload,
  detectCurrentAgentFromHookPayload,
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
import { reconcileStopTaskSnapshot } from "./missing-task-guard.ts"

export interface StopIncompleteTasksDependencies {
  homeDir?: string
  resolveContext?: typeof resolveTaskCheckContext
}

function withNotice(output: SwizHookOutput, notice: string | undefined): SwizHookOutput {
  return notice ? { ...output, systemMessage: notice } : output
}

/**
 * Evaluate incomplete tasks and return blocking output or empty object.
 */
export async function evaluateStopIncompleteTasks(
  input: StopHookInput,
  dependencies: StopIncompleteTasksDependencies = {}
): Promise<SwizHookOutput> {
  // CLI fast path already scanned tasks and found no blockers — skip redundant disk read
  if ((input as Record<string, unknown>)._fastPathTaskScanComplete) return {}

  const ctx = await (dependencies.resolveContext ?? resolveTaskCheckContext)(
    input,
    dependencies.homeDir
  )
  if (!ctx) return {}

  if (!agentHasTaskToolsForHookPayload(input as Record<string, any>)) return {}
  // Gemini agent exemption
  if (detectCurrentAgentFromHookPayload(input as Record<string, any>)?.id === "gemini") return {}
  const taskListAvailable = agentHasTaskListToolForHookPayload(input as Record<string, any>)
  const taskListToolName = taskToolNameForHookPayload(input as Record<string, any>, "TaskList")
  const taskUpdateToolName = taskToolNameForHookPayload(input as Record<string, any>, "TaskUpdate")

  const reconciled = await reconcileStopTaskSnapshot(ctx)
  ctx.allTasks = reconciled.tasks

  const remainingIncomplete = filterIncompleteStatus(ctx.allTasks)
  if (remainingIncomplete.length === 0) {
    return withNotice({}, reconciled.notice)
  }

  const blockingIncomplete = filterBlockingIncomplete(ctx.allTasks)
  if (blockingIncomplete.length === 0) {
    // Edge case: having deferred tasks as the sole remaining tasks. That is
    // likely a dodge — the agent parked real work under a "Future:" label instead
    // of completing it. Steer back to the actual work.
    const subjects = remainingIncomplete
      .map((t) => t.subject ?? "")
      .map((s) => stripDeferralPrefix(s) || s)
    return withNotice(buildSoleDeferralSteeringOutput(subjects), reconciled.notice)
  }

  // Build block output — list all incomplete tasks so the agent knows to complete everything.
  const taskDetails = getIncompleteDetails(ctx.allTasks)
  const output = buildIncompleteBlockOutput(taskDetails, {
    tasksDir: ctx.tasksDir,
    sessionId: ctx.sessionId,
    taskListAvailable,
    taskListToolName,
    taskUpdateToolName,
  })
  return withNotice(output, reconciled.notice)
}
