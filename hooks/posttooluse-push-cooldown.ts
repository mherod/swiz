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

import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import {
  GIT_PUSH_RE,
  getCanonicalPathHash,
  git,
  hasGitPushForceFlag,
  isShellTool,
  type ToolHookInput,
} from "./utils/hook-utils.ts"

interface ExtendedToolHookInput extends ToolHookInput {
  tool_response?: string | null
}

const input = (await Bun.stdin.json()) as ExtendedToolHookInput
if (!input.tool_name || !isShellTool(input.tool_name)) process.exit(0)

const command = String(input.tool_input?.command ?? "")
if (!GIT_PUSH_RE.test(command)) process.exit(0)

// Force-flag pushes bypass cooldown entirely — no sentinel needed.
if (hasGitPushForceFlag(command)) process.exit(0)

// Background push detection — mirror the logic from posttooluse-verify-push.ts.
// For background pushes, PostToolUse fires before the push process starts;
// don't write the sentinel here (the cooldown period would start too early).
const isBackground =
  input.tool_input?.run_in_background === true ||
  /\s+&\s*$|\s+&\s/.test(command) ||
  (typeof input.tool_response === "string" &&
    /running in background|background task/i.test(input.tool_response))

if (isBackground) process.exit(0)

// Derive the same per-repo sentinel path as pretooluse-push-cooldown.ts.
const cwd = input.cwd ?? process.cwd()
const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
const repoKey = getCanonicalPathHash(repoRoot || cwd)
const sentinelPath = swizPushCooldownSentinelPath(repoKey)

// Write the timestamp — this arms the cooldown for subsequent push attempts.
try {
  await Bun.write(sentinelPath, String(Date.now()))
} catch {
  // Non-fatal: if we can't write the sentinel, cooldown simply won't apply.
}
