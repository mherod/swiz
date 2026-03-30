#!/usr/bin/env bun

// PostToolUse hook: Remind agents to create/update tasks regularly
// Provides countdown hints showing remaining calls until mandatory enforcement
// Uses current-session tool history (daemon-injected when available) to determine position

import {
  emitContext,
  getCurrentSessionTaskToolStats,
  isEditTool,
  isWriteTool,
  scheduleAutoSteer,
  toolNameForCurrentAgent,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Tool calls in a session with no task tools yet before TaskCreate is required. */
const CREATION_THRESHOLD = 5

/** Tool calls since the last task tool before staleness messaging escalates. */
const STALENESS_THRESHOLD = 10

/** Beyond this many calls since a task update, append the severe-stale appendix. */
const STALE_EXTREME_CALLS = 20

const SEVERE_STALE_APPENDIX =
  "Penalties for neglect will be applied imminently. Task management has been forgotten for too long and we must address this immediately, failure to do will result in permanent termination of necessary resources."

let advisorSessionId = ""
let advisorCwd: string | undefined

/**
 * Pushes advisory text to the agent; optionally schedules auto-steer when a session id is set.
 */
async function emitAdvisorContext(
  message: string,
  opts?: { skipAutoSteer?: boolean }
): Promise<never> {
  if (advisorSessionId && !opts?.skipAutoSteer) {
    await scheduleAutoSteer(advisorSessionId, message, undefined, advisorCwd)
  }
  return emitContext("PostToolUse", message)
}

function emitCreationCountdown(total: number, threshold: number, taskCreateName: string): void {
  const remaining = threshold - total
  if (remaining <= 0) return

  if (remaining <= 1) {
    void emitAdvisorContext(
      `${taskCreateName} required in ${remaining} tool call(s) — tools will be blocked until tasks are defined.`
    )
    return
  }
  if (remaining <= 3) {
    void emitAdvisorContext(
      `${taskCreateName} required in ${remaining} tool calls. Plan your tasks now to avoid interruption.`
    )
    return
  }
  if (total >= 2) {
    void emitAdvisorContext(
      `${total}/${threshold} tool calls before ${taskCreateName} is required.`
    )
  }
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

async function main(): Promise<void> {
  const hookRaw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = toolHookInputSchema.parse(hookRaw)

  advisorSessionId = input.session_id ?? ""
  advisorCwd = input.cwd

  const { totalToolCalls, callsSinceLastTaskTool } = await getCurrentSessionTaskToolStats(hookRaw)
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")

  if (callsSinceLastTaskTool >= totalToolCalls) {
    emitCreationCountdown(totalToolCalls, CREATION_THRESHOLD, taskCreateName)
    return
  }

  const staleRemaining = STALENESS_THRESHOLD - callsSinceLastTaskTool
  const message = stalenessWarningMessage(
    callsSinceLastTaskTool,
    staleRemaining,
    input.tool_name ?? ""
  )

  if (message) {
    void emitAdvisorContext(message, { skipAutoSteer: true })
  }
}

if (import.meta.main) {
  void main()
}
