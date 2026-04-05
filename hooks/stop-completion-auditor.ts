#!/usr/bin/env bun

// Modular stop hook: Verify task creation and CI evidence after all tasks are complete.
// Incomplete-task blocking is handled by the higher-priority stop-incomplete-tasks hook.
//
// Architecture: This hook orchestrates four separable validation layers via modular
// submodules (types, context, validators, action-plan, evaluate). Each validator
// can be tested independently and composed into a unified validation pipeline.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "./schemas.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { evaluateStopCompletionAuditor } from "./stop-completion-auditor/evaluate.ts"

export async function evaluateStopCompletionAuditorHook(
  input: StopHookInput
): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  return await evaluateStopCompletionAuditor(parsed)
}

const stopCompletionAuditor: SwizStopHook = {
  name: "stop-completion-auditor",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopCompletionAuditorHook(input)
  },
}

export default stopCompletionAuditor

if (import.meta.main) {
  await runSwizHookAsMain(stopCompletionAuditor)
}
