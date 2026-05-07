#!/usr/bin/env bun

// PostToolUse hook: Remind agents to create/update tasks regularly
// Dual-mode: SwizHook + runSwizHookAsMain.

import { agentHasTaskToolsForHookPayload } from "../src/agent-paths.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import {
  buildTaskAdvisorStalenessMessage,
  buildTaskCreationCountdownMessage,
} from "../src/tasks/task-governance-messages.ts"
import {
  buildContextHookOutput,
  getCurrentSessionTaskToolStats,
  isEditTool,
  isWriteTool,
  scheduleAutoSteer,
  toolNameForCurrentAgent,
} from "../src/utils/hook-utils.ts"

const CREATION_THRESHOLD = 5
const STALENESS_THRESHOLD = 10

let advisorSessionId = ""
let advisorCwd: string | undefined

async function emitAdvisorContext(
  message: string,
  opts?: { skipAutoSteer?: boolean }
): Promise<SwizHookOutput> {
  if (advisorSessionId && !opts?.skipAutoSteer) {
    await scheduleAutoSteer(advisorSessionId, message, undefined, advisorCwd)
  }
  return buildContextHookOutput("PostToolUse", message)
}

async function emitCreationCountdown(
  total: number,
  threshold: number,
  taskCreateName: string
): Promise<SwizHookOutput> {
  const message = buildTaskCreationCountdownMessage(total, threshold, taskCreateName)
  return message ? await emitAdvisorContext(message) : {}
}

function stalenessWarningMessage(
  callsSinceTask: number,
  staleRemaining: number,
  toolName: string
): string | undefined {
  return buildTaskAdvisorStalenessMessage(
    callsSinceTask,
    staleRemaining,
    toolName,
    isEditTool(toolName) || isWriteTool(toolName)
  )
}

export async function evaluatePosttooluseTaskAdvisor(input: unknown): Promise<SwizHookOutput> {
  const hookRaw = typeof input === "object" && input !== null ? (input as Record<string, any>) : {}
  if (!agentHasTaskToolsForHookPayload(hookRaw)) return {}
  const parsed = toolHookInputSchema.parse(hookRaw)

  advisorSessionId = parsed.session_id ?? ""
  advisorCwd = parsed.cwd

  const { totalToolCalls, callsSinceLastTaskTool } = await getCurrentSessionTaskToolStats(hookRaw)
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")

  if (callsSinceLastTaskTool >= totalToolCalls) {
    return await emitCreationCountdown(totalToolCalls, CREATION_THRESHOLD, taskCreateName)
  }

  const staleRemaining = STALENESS_THRESHOLD - callsSinceLastTaskTool
  const message = stalenessWarningMessage(
    callsSinceLastTaskTool,
    staleRemaining,
    parsed.tool_name ?? ""
  )

  if (message) {
    return await emitAdvisorContext(message, { skipAutoSteer: true })
  }
  return {}
}

const posttooluseTaskAdvisor: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-advisor",
  event: "postToolUse",
  matcher: "Edit|Write",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskAdvisor(input)
  },
}

export default posttooluseTaskAdvisor

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskAdvisor)
}
