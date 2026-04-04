#!/usr/bin/env bun

// Block stop when incomplete tasks remain in the current session.
// Runs before the completion auditor so incomplete tasks are caught early.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { isCurrentAgent } from "../src/agent-paths.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { isTaskListTool, isTaskTool } from "../src/tool-matchers.ts"
import { getToolsUsedForCurrentSession } from "../src/transcript-summary.ts"
import { blockStopObj } from "../src/utils/hook-utils.ts"
import { checkIncompleteTasks } from "../src/utils/stop-incomplete-tasks-core.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

export async function evaluateStopIncompleteTasks(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const sessionId = parsed.session_id ?? ""
  const home = getHomeDirOrNull()
  if (!home) return {}

  if (isCurrentAgent("gemini")) return {}

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

  const result = await checkIncompleteTasks(sessionId, home)
  return result ?? {}
}

const stopIncompleteTasks: SwizStopHook = {
  name: "stop-incomplete-tasks",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopIncompleteTasks(input)
  },
}

export default stopIncompleteTasks

if (import.meta.main) {
  await runSwizHookAsMain(stopIncompleteTasks)
}
