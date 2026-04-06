#!/usr/bin/env bun

// Modular stop hook: Block stop if git repository has uncommitted changes or unpushed commits.
//
// Architecture: This hook modularizes git workflow validation into independent,
// testable validators (types, context, uncommitted-changes, remote-state, push-cooldown,
// background-push-detector, action-plan, evaluate).
// Each component can be tested separately and composed into a unified validation pipeline.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { stopHookInputSchema } from "../src/schemas.ts"
import { collectGitWorkflowStop, evaluateStopGitStatus } from "./stop-git-status/evaluate.ts"
import { markPushPrompted } from "./stop-git-status/push-cooldown-validator.ts"

export async function evaluateStopGitStatusHook(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  return await evaluateStopGitStatus(parsed)
}

// Re-export for stop-ship-checklist composition
export { collectGitWorkflowStop, markPushPrompted }

const stopGitStatus: SwizStopHook = {
  name: "stop-git-status",
  event: "stop",
  timeout: 10,
  requiredSettings: ["gitStatusGate"],

  run(input) {
    return evaluateStopGitStatusHook(input)
  },
}

export default stopGitStatus

if (import.meta.main) {
  await runSwizHookAsMain(stopGitStatus)
}
