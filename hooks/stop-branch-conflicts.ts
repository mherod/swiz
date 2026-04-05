#!/usr/bin/env bun

// Stop hook: Block stop if current branch has conflicts with the default branch.
// Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)
//
// Modular architecture: types → context → validators → action-plan → evaluate → wrapper
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluateStopBranchConflicts } from "./stop-branch-conflicts/evaluate.ts"

const stopBranchConflicts: SwizStopHook = {
  name: "stop-branch-conflicts",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopBranchConflicts(input)
  },
}

export default stopBranchConflicts

if (import.meta.main) {
  await runSwizHookAsMain(stopBranchConflicts)
}
