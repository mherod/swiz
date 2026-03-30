#!/usr/bin/env bun

// Stop hook: Block stop when the remote has too many branches.
// Fires when `origin` has more than BRANCH_LIMIT remote-tracking branches.
// Cooldown (cooldownSeconds: 7200 in manifest) is enforced by the dispatcher.
//
// Dual-mode: exports a SwizStopHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { blockStopObj, git, isGitRepo, skillAdvice } from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const BRANCH_LIMIT = 40

async function evaluate(input: StopHookInput): Promise<SwizHookOutput> {
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const raw = await git(["branch", "-r"], cwd)
  if (!raw) return {}

  const branches = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes("->"))

  const count = branches.length
  if (count <= BRANCH_LIMIT) return {}

  const excess = count - BRANCH_LIMIT
  const reason =
    `Remote 'origin' has ${count} branches (limit: ${BRANCH_LIMIT}, ${excess} over limit).\n\n` +
    `Too many stale branches accumulate over time and slow down git operations, ` +
    `code review, and branch listing. Prune merged and unused branches before stopping.\n\n` +
    skillAdvice(
      "prune-branches",
      "Use the /prune-branches skill to clean up merged and unused branches.",
      `Prune stale branches:\n` +
        `  git fetch --prune\n` +
        `  git branch -r --merged origin/main | grep -v "origin/main" | ` +
        `sed 's|^\\s*origin/||' | xargs -I{} git push origin --delete {}`
    )

  return blockStopObj(reason, { includeUpdateMemoryAdvice: false })
}

const stopUpstreamBranchCount: SwizStopHook = {
  name: "stop-upstream-branch-count",
  event: "stop",
  timeout: 10,
  cooldownSeconds: 7200,

  run(rawInput) {
    const input = stopHookInputSchema.parse(rawInput)
    return evaluate(input)
  },
}

export default stopUpstreamBranchCount

if (import.meta.main) {
  await runSwizHookAsMain(stopUpstreamBranchCount)
}
