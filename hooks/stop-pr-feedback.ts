#!/usr/bin/env bun

/**
 * Stop hook: Check for PRs with feedback or merge conflicts
 * Blocks stop if current user has open PRs needing review attention or containing merge conflicts
 */

import type { SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluateStopPrFeedback } from "./stop-pr-feedback/evaluate.ts"
export { evaluateStopPrFeedback }

/** Subprocess/E2E entry only — manifest uses this hook directly. */
const stopPrFeedback: SwizStopHook = {
  name: "stop-pr-feedback",
  event: "stop",
  timeout: 10,
  cooldownSeconds: 30,
  requiredSettings: ["changesRequestedGate"],

  run(input) {
    return evaluateStopPrFeedback(input)
  },
}

export default stopPrFeedback

if (import.meta.main) {
  await runSwizHookAsMain(stopPrFeedback)
}
