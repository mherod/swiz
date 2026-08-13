#!/usr/bin/env bun

// Modular stop hook: Block stop when incomplete tasks remain in the current session.
//
// Architecture: This hook modularizes task checking into independent,
// testable validators (types, context, task-dedup-validator, incomplete-check-validator,
// action-plan, evaluate).
// Each component can be tested separately and composed into a unified validation pipeline.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import {
  agentHasTaskListToolForHookPayload,
  agentHasTaskToolsForHookPayload,
  detectCurrentAgentFromHookPayload,
  shouldEnforceIncompleteTasksForHookPayload,
} from "../src/agent-paths.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { stopHookInputSchema } from "../src/schemas.ts"
import { getRecentlyUsedToolsForCurrentSession } from "../src/skill-utils.ts"
import { buildTaskListBeforeStopMessage } from "../src/tasks/task-governance-messages.ts"
import { isTaskListTool, isTaskTool } from "../src/tool-matchers.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
import {
  evaluateStopIncompleteTasks,
  type StopIncompleteTasksDependencies,
} from "./stop-incomplete-tasks/evaluate.ts"

async function isAutoContinueDisabled(input: StopHookInput): Promise<boolean> {
  try {
    const { getEffectiveSwizSettings, readSwizSettings, readProjectSettings } = await import(
      "../src/settings.ts"
    )
    const rawInput = input as Record<string, any>
    const cwd = typeof rawInput.cwd === "string" ? rawInput.cwd : process.cwd()
    const rawSettings = await readSwizSettings({ strict: true })
    const projectSettings = await readProjectSettings(cwd).catch(() => null)
    const effective =
      (rawInput._effectiveSettings as ReturnType<typeof getEffectiveSwizSettings> | undefined) ??
      getEffectiveSwizSettings(rawSettings, input.session_id, projectSettings ?? undefined)
    return effective.autoContinue === false
  } catch {
    // Fail open on settings error
    return false
  }
}

async function shouldRequireTaskListBeforeStop(input: StopHookInput): Promise<boolean> {
  const rawInput = input as Record<string, any>
  const agent = detectCurrentAgentFromHookPayload(rawInput)
  if (agent?.id !== "claude" || !agentHasTaskListToolForHookPayload(rawInput)) return false

  const toolNames = await getRecentlyUsedToolsForCurrentSession(rawInput)
  const hasTaskActivity = toolNames.some((toolName) => isTaskTool(toolName))
  const hasTaskList = toolNames.some((toolName) => isTaskListTool(toolName))
  return hasTaskActivity && !hasTaskList
}

export async function evaluateStopIncompleteTasksHook(
  input: StopHookInput,
  dependencies: StopIncompleteTasksDependencies = {}
): Promise<SwizHookOutput> {
  if (!shouldEnforceIncompleteTasksForHookPayload(input as Record<string, any>)) return {}
  if (!agentHasTaskToolsForHookPayload(input as Record<string, any>)) return {}
  if (await isAutoContinueDisabled(input)) return {}
  const parsed = stopHookInputSchema.parse(input)

  // Require TaskList before stop when the session has used task tools and is running inside Claude.
  // This ensures the task-state-cache is synced via posttooluse-task-list-sync.
  if (await shouldRequireTaskListBeforeStop(input)) {
    return blockStopObj(buildTaskListBeforeStopMessage())
  }

  return await evaluateStopIncompleteTasks(parsed, dependencies)
}

const stopIncompleteTasks: SwizStopHook = {
  name: "stop-incomplete-tasks",
  event: "stop",
  timeout: 10,
  requiredSettings: ["autoContinue"],

  run(input) {
    return evaluateStopIncompleteTasksHook(input)
  },
}

export default stopIncompleteTasks

if (import.meta.main) {
  await runSwizHookAsMain(stopIncompleteTasks)
}
