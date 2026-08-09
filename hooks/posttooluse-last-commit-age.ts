#!/usr/bin/env bun

// PostToolUse hook: Keep time since the last commit visible during active work.

import { formatDuration } from "../src/format-duration.ts"
import { getHeadCommitAgeMs } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"

export function formatLastCommitAgeContext(ageMs: number): string | null {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null
  return `Last commit was ${formatDuration(ageMs)} ago.`
}

export async function evaluatePosttooluseLastCommitAge(
  input: ToolHookInput,
  nowMs = Date.now()
): Promise<SwizHookOutput> {
  const cwd = input.cwd
  if (!cwd || !(await isGitRepoForHookPayload(input, cwd))) return {}

  const ageMs = await getHeadCommitAgeMs(cwd, nowMs)
  if (ageMs === null) return {}

  const context = formatLastCommitAgeContext(ageMs)
  return context ? buildContextHookOutput("PostToolUse", context) : {}
}

const posttooluseLastCommitAge: SwizHook = {
  name: "posttooluse-last-commit-age",
  event: "postToolUse",
  cooldownSeconds: 60,
  cooldownMode: "always",
  timeout: 5,
  run(input: ToolHookInput) {
    return evaluatePosttooluseLastCommitAge(input)
  },
}

export default posttooluseLastCommitAge

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseLastCommitAge)
}
