#!/usr/bin/env bun

/**
 * PostToolUse hook: Verify that a git push actually landed on the remote.
 *
 * After any Bash tool call containing `git push`, checks that the local HEAD
 * SHA matches the remote tracking branch SHA. If they diverge — meaning the
 * push failed silently or was skipped — blocks with a hard error so the agent
 * cannot report push success and move on.
 *
 * Passthrough (no output):
 *   - No git push in command
 *   - Background push (any detection signal fires) — verify via TaskOutput
 *   - No upstream tracking branch — push-cooldown handles it
 *   - Not a git repo
 *
 * Success: additionalContext confirming push landed (immediate or after retry).
 * Failure after ~15s retry: PostToolUse block via deny payload.
 *
 * Background push detection (multi-signal, first match wins):
 *   1. tool_input.run_in_background === true
 *   2. command ends with " &" or contains " & "
 *   3. tool_response contains "running in background" or "background task"
 *
 * Dual-mode: exports a SwizHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import {
  buildContextHookOutput,
  buildDenyPostToolUseOutput,
  GIT_PUSH_RE,
  git,
  isShellTool,
} from "../src/utils/hook-utils.ts"

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] // 1s, 2s, 4s, 8s → 15s total

function isBackgroundPush(input: PostToolHookInput, command: string): boolean {
  if (input.tool_input?.run_in_background === true) return true
  if (/\s+&\s*$|\s+&\s/.test(command)) return true
  if (
    typeof input.tool_response === "string" &&
    /running in background|background task/i.test(input.tool_response)
  ) {
    return true
  }
  return false
}

function getPushCommand(input: PostToolHookInput): string | null {
  if (!input.tool_name || !isShellTool(input.tool_name)) return null
  const command = input.tool_input?.command
  if (typeof command !== "string") return null
  if (!GIT_PUSH_RE.test(command)) return null
  if (isBackgroundPush(input, command)) return null
  return command
}

async function verifyWithRetries(localHead: string, cwd: string): Promise<SwizHookOutput> {
  const getRemoteHead = async (): Promise<string> => {
    await git(["fetch", "--quiet"], cwd)
    return (await git(["rev-parse", "@{upstream}"], cwd)) ?? ""
  }

  for (const delayMs of RETRY_DELAYS_MS) {
    await Bun.sleep(delayMs)
    const refreshed = await getRemoteHead()
    if (refreshed === localHead) {
      return buildContextHookOutput(
        "PostToolUse",
        `Push verified (after ${delayMs}ms retry): HEAD ${localHead.slice(0, 8)} is confirmed on the remote tracking branch.`
      )
    }
  }

  const finalRemote = await getRemoteHead()
  return buildDenyPostToolUseOutput(
    `Push verification failed: local HEAD (${localHead.slice(0, 8)}) does not match remote tracking branch (${finalRemote.slice(0, 8) || "unknown"}).\n\n` +
      `Checked after retrying for ~15 seconds. Possible causes:\n` +
      `  • The push was rejected (non-fast-forward, branch protection, hook failure)\n` +
      `  • A different branch/ref was pushed than HEAD\n\n` +
      `Run \`git log origin/$(git branch --show-current)..HEAD --oneline\` to see unpushed commits, then push again.`
  )
}

async function evaluate(input: PostToolHookInput): Promise<SwizHookOutput> {
  const command = getPushCommand(input)
  if (!command) return {}

  const cwd = input.cwd ?? process.cwd()

  const localHead = await git(["rev-parse", "HEAD"], cwd)
  if (!localHead) return {}

  const remoteHead = await git(["rev-parse", "@{upstream}"], cwd)
  if (!remoteHead) return {}

  if (localHead === remoteHead) {
    return buildContextHookOutput(
      "PostToolUse",
      `Push verified: HEAD ${localHead.slice(0, 8)} is confirmed on the remote tracking branch.`
    )
  }

  return await verifyWithRetries(localHead, cwd)
}

const posttoolusVerifyPush: SwizHook<PostToolHookInput> = {
  name: "posttooluse-verify-push",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 20,

  run(input) {
    return evaluate(input)
  },
}

export default posttoolusVerifyPush

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusVerifyPush)
}
