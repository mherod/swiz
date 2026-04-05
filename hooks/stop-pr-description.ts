#!/usr/bin/env bun

// Stop hook: Block stop if open PR has empty or placeholder description
//
// Modular architecture: types → context → validators → action-plan → evaluate → wrapper
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluateStopPrDescription } from "./stop-pr-description/evaluate.ts"

const stopPrDescription: SwizStopHook = {
  name: "stop-pr-description",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopPrDescription(input)
  },
}

export default stopPrDescription

if (import.meta.main) {
  await runSwizHookAsMain(stopPrDescription)
}
