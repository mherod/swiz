#!/usr/bin/env bun

// PostToolUse hook: Write the push-cooldown sentinel after a git push executes.
//
// This is the write-side of the push-cooldown pair:
//   pretooluse-push-cooldown.ts  — reads sentinel, blocks if within 60s
//   posttooluse-push-cooldown.ts — writes sentinel after push completes
//
// By writing the sentinel here (PostToolUse) rather than in PreToolUse, only
// pushes that actually execute (i.e. weren't blocked by a subsequent hook)
// arm the cooldown. Blocked pushes no longer trigger a false cooldown.
//
// Background pushes are detected and skipped — their sentinel is not written
// until the background task completes; the cooldown is handled by the
// pretooluse hook reading the stale sentinel.

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import {
  GIT_PUSH_RE,
  getCanonicalPathHash,
  git,
  hasGitPushForceFlag,
  isShellTool,
} from "../src/utils/hook-utils.ts"

function getEligibleCommand(hookInput: PostToolHookInput): string | null {
  if (!hookInput.tool_name || !isShellTool(hookInput.tool_name)) return null

  const command = String(hookInput.tool_input?.command ?? "")
  if (!GIT_PUSH_RE.test(command) || hasGitPushForceFlag(command)) return null

  return command
}

function isBackgroundPush(hookInput: PostToolHookInput, command: string): boolean {
  return (
    hookInput.tool_input?.run_in_background === true ||
    /\s+&\s*$|\s+&\s/.test(command) ||
    (typeof hookInput.tool_response === "string" &&
      /running in background|background task/i.test(hookInput.tool_response))
  )
}

export async function evaluatePosttoolusePushCooldown(input: unknown): Promise<SwizHookOutput> {
  const hookInput = input as PostToolHookInput

  const command = getEligibleCommand(hookInput)
  if (!command) return {}

  if (isBackgroundPush(hookInput, command)) return {}

  const cwd = hookInput.cwd ?? process.cwd()
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  const repoKey = getCanonicalPathHash(repoRoot || cwd)
  const sentinelPath = swizPushCooldownSentinelPath(repoKey)

  try {
    await Bun.write(sentinelPath, String(Date.now()))
  } catch {
    // Non-fatal: if we can't write the sentinel, cooldown simply won't apply.
  }

  return {}
}

const posttoolusePushCooldown: SwizHook<PostToolHookInput> = {
  name: "posttooluse-push-cooldown",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,
  run(input) {
    return evaluatePosttoolusePushCooldown(input)
  },
}

export default posttoolusePushCooldown

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusePushCooldown as SwizHook<Record<string, any>>)
}
