#!/usr/bin/env bun

// Modular stop hook: Verify lockfile is updated when dependencies change.
// Prevents out-of-sync package.json and lockfile states.
//
// Architecture: This hook modularizes drift detection into independent,
// testable validators (types, context, detector, validator, action-plan, evaluate).
// Each component can be tested separately and composed into a unified validation pipeline.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "./schemas.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { evaluateStopLockfileDrift } from "./stop-lockfile-drift/evaluate.ts"

export async function evaluateStopLockfileDriftHook(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  return await evaluateStopLockfileDrift(parsed)
}

const stopLockfileDrift: SwizStopHook = {
  name: "stop-lockfile-drift",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopLockfileDriftHook(input)
  },
}

export default stopLockfileDrift

if (import.meta.main) {
  await runSwizHookAsMain(stopLockfileDrift)
}
