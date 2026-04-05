#!/usr/bin/env bun

// Modular stop hook: Block stop when incomplete tasks remain in the current session.
//
// Architecture: This hook modularizes task checking into independent,
// testable validators (types, context, task-dedup-validator, incomplete-check-validator,
// action-plan, evaluate).
// Each component can be tested separately and composed into a unified validation pipeline.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getToolsUsedForCurrentSession } from "../src/transcript-summary.ts"
import { blockStopObj, isTaskListTool, isTaskTool } from "../src/utils/hook-utils.ts"
import type { StopHookInput } from "./schemas.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { evaluateStopIncompleteTasks } from "./stop-incomplete-tasks/evaluate.ts"

export async function evaluateStopIncompleteTasksHook(
  input: StopHookInput
): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)

  // Require TaskList before stop when the session has used task tools.
  // This ensures the task-state-cache is synced via posttooluse-task-list-sync.
  const transcriptSource = (input as Record<string, any>) ?? parsed.transcript_path ?? ""
  if (transcriptSource) {
    const toolNames = await getToolsUsedForCurrentSession(transcriptSource)
    const hasTaskActivity = toolNames.some((n) => isTaskTool(n))
    const hasTaskList = toolNames.some((n) => isTaskListTool(n))
    if (hasTaskActivity && !hasTaskList) {
      return blockStopObj(
        "Call TaskList before stopping to sync task state.\n\n" +
          "The session used task tools but never called TaskList. " +
          "Run TaskList now, then retry stop."
      )
    }
  }

  return await evaluateStopIncompleteTasks(parsed)
}

const stopIncompleteTasks: SwizStopHook = {
  name: "stop-incomplete-tasks",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopIncompleteTasksHook(input)
  },
}

export default stopIncompleteTasks

if (import.meta.main) {
  await runSwizHookAsMain(stopIncompleteTasks)
}
