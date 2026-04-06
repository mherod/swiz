#!/usr/bin/env bun

// Unified stop gate: git sync, GitHub CI (feature-branch peer-review mode), and
// actionable issues/PRs — one preamble and one numbered action plan for the agent.
//
// Respects per-gate settings: gitStatusGate, githubCiGate, personalRepoIssuesGate.
//
// This hook is a thin wrapper around the modular stop-ship-checklist/evaluate module
// that orchestrates three separable workflow concerns.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { evaluateStopShipChecklist } from "./stop-ship-checklist/evaluate.ts"

export async function evaluateStopShipChecklistHook(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  return await evaluateStopShipChecklist(parsed)
}

const stopShipChecklist: SwizStopHook = {
  name: "stop-ship-checklist",
  event: "stop",
  timeout: 65,

  run(input) {
    return evaluateStopShipChecklistHook(input)
  },
}

export default stopShipChecklist

if (import.meta.main) {
  await runSwizHookAsMain(stopShipChecklist)
}
