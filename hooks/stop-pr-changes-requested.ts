#!/usr/bin/env bun

// Stop hook: Block stop if current branch has CHANGES_REQUESTED reviews
//
// Modular architecture: types → context → validators → action-plan → evaluate → wrapper
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluateStopPrChangesRequested } from "./stop-pr-changes-requested/evaluate.ts"

const stopPrChangesRequested: SwizStopHook = {
  name: "stop-pr-changes-requested",
  event: "stop",
  timeout: 10,
  requiredSettings: ["changesRequestedGate"],

  run(input) {
    return evaluateStopPrChangesRequested(input)
  },
}

export default stopPrChangesRequested

if (import.meta.main) {
  await runSwizHookAsMain(stopPrChangesRequested)
}
