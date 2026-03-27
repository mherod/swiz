#!/usr/bin/env bun

// PostToolUse hook: Remind agents to create/update tasks regularly
// Provides countdown hints showing remaining calls until mandatory enforcement
// Uses current-session tool history (daemon-injected when available) to determine position

import { toolHookInputSchema } from "./schemas.ts"
import {
  emitContext,
  getCurrentSessionTaskToolStats,
  isEditTool,
  isWriteTool,
  scheduleAutoSteer,
  toolNameForCurrentAgent,
} from "./utils/hook-utils.ts"

function emitCreationCountdown(total: number, threshold: number, taskCreateName: string): void {
  const remaining = threshold - total
  if (remaining <= 0) return
  if (remaining <= 1) {
    void emit(
      `${taskCreateName} required in ${remaining} tool call(s) — tools will be blocked until tasks are defined.`
    )
  } else if (remaining <= 3) {
    void emit(
      `${taskCreateName} required in ${remaining} tool calls. Plan your tasks now to avoid interruption.`
    )
  } else if (total >= 2) {
    void emit(`${total}/${threshold} tool calls before ${taskCreateName} is required.`)
  }
}

function emitStalenessWarning(
  callsSinceTask: number,
  staleRemaining: number,
  toolName: string
): void {
  if (staleRemaining <= 0) {
    if (isEditTool(toolName) || isWriteTool(toolName)) {
      void emit(
        `Tasks need attention — it's been ${callsSinceTask} tool calls since the last task update. ` +
          `Review progress: mark completed tasks done, update in-progress tasks with current status, ` +
          `or create new tasks for the work underway.`,
        { skipAutoSteer: true }
      )
    }
    return
  }
  if (staleRemaining <= 2) {
    void emit(
      `Task update required in ${staleRemaining} tool call(s) — tools will be blocked until tasks are reviewed.`,
      { skipAutoSteer: true }
    )
  } else if (staleRemaining <= 4) {
    void emit(
      `Task update due in ${staleRemaining} tool calls. Review progress — mark completed tasks done or create new ones.`,
      { skipAutoSteer: true }
    )
  }
}

let _sessionId = ""
let _cwd: string | undefined

async function main(): Promise<void> {
  const hookRaw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = toolHookInputSchema.parse(hookRaw)
  _sessionId = (input.session_id as string) ?? ""
  _cwd = input.cwd
  const { totalToolCalls, callsSinceLastTaskTool } = await getCurrentSessionTaskToolStats(hookRaw)
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")

  const CREATION_THRESHOLD = 5
  const STALENESS_THRESHOLD = 10

  if (callsSinceLastTaskTool >= totalToolCalls) {
    emitCreationCountdown(totalToolCalls, CREATION_THRESHOLD, taskCreateName)
    return
  }

  const staleRemaining = STALENESS_THRESHOLD - callsSinceLastTaskTool
  emitStalenessWarning(callsSinceLastTaskTool, staleRemaining, (input.tool_name ?? "") as string)
}

async function emit(context: string, opts?: { skipAutoSteer?: boolean }): Promise<never> {
  if (_sessionId && !opts?.skipAutoSteer) {
    await scheduleAutoSteer(_sessionId, context, undefined, _cwd)
  }
  return emitContext("PostToolUse", context)
}

if (import.meta.main) void main()
