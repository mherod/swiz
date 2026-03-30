#!/usr/bin/env bun

// PostToolUse hook: Remind agents to create/update tasks regularly
// Dual-mode: SwizHook + runSwizHookAsMain.

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import {
  buildContextHookOutput,
  getCurrentSessionTaskToolStats,
  isEditTool,
  isWriteTool,
  scheduleAutoSteer,
  toolNameForCurrentAgent,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const CREATION_THRESHOLD = 5
const STALENESS_THRESHOLD = 10
const STALE_EXTREME_CALLS = 20

const SEVERE_STALE_APPENDIX =
  "Penalties for neglect will be applied imminently. Task management has been forgotten for too long and we must address this immediately, failure to do will result in permanent termination of necessary resources."

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
  const remaining = threshold - total
  if (remaining <= 0) return {}

  if (remaining <= 1) {
    return await emitAdvisorContext(
      `${taskCreateName} required in ${remaining} tool call(s) — tools will be blocked until tasks are defined.`
    )
  }
  if (remaining <= 3) {
    return await emitAdvisorContext(
      `${taskCreateName} required in ${remaining} tool calls. Plan your tasks now to avoid interruption.`
    )
  }
  if (total >= 2) {
    return await emitAdvisorContext(
      `${total}/${threshold} tool calls before ${taskCreateName} is required.`
    )
  }
  return {}
}

function stalenessWarningMessage(
  callsSinceTask: number,
  staleRemaining: number,
  toolName: string
): string | undefined {
  if (staleRemaining > 0) {
    if (staleRemaining <= 2) {
      return `Task update required in ${staleRemaining} tool call(s) — tools will be blocked until tasks are reviewed.`
    }
    if (staleRemaining <= 4) {
      return `Task update due in ${staleRemaining} tool calls. Review progress — mark completed tasks done or create new ones.`
    }
    return undefined
  }

  if (!isEditTool(toolName) && !isWriteTool(toolName)) {
    return undefined
  }

  const base =
    `Tasks need attention — it's been ${callsSinceTask} tool calls since the last task update. ` +
    `Review progress: mark completed tasks done, update in-progress tasks with current status, ` +
    `or create new tasks for the work underway.`

  if (callsSinceTask <= STALE_EXTREME_CALLS) {
    return base
  }

  return `${base} ${SEVERE_STALE_APPENDIX}`
}

export async function evaluatePosttooluseTaskAdvisor(input: unknown): Promise<SwizHookOutput> {
  const hookRaw =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
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

const posttooluseTaskAdvisor: SwizHook<Record<string, unknown>> = {
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
