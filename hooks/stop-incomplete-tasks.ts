#!/usr/bin/env bun

// Block stop when incomplete tasks remain in the current session.
// Runs before the completion auditor so incomplete tasks are caught early.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { isCurrentAgent } from "../src/agent-paths.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { checkIncompleteTasks } from "../src/utils/stop-incomplete-tasks-core.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

export async function evaluateStopIncompleteTasks(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const sessionId = parsed.session_id ?? ""
  const home = getHomeDirOrNull()
  if (!home) return {}

  if (isCurrentAgent("gemini")) return {}

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
