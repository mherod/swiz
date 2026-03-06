#!/usr/bin/env bun
/**
 * PostToolUse hook: Verify that a git push actually landed on the remote.
 *
 * After any Bash tool call containing `git push`, checks that the local HEAD
 * SHA matches the remote tracking branch SHA. If they diverge — meaning the
 * push failed silently or was skipped — blocks with a hard error so the agent
 * cannot report push success and move on.
 *
 * Exit conditions:
 *   - No git push in command → exit 0 (passthrough)
 *   - Background push (tool_response contains "running in background") → exit 0 (verify via TaskOutput)
 *   - No upstream tracking branch → exit 0 (untracked branch; push-cooldown handles it)
 *   - HEAD matches remote (immediate or after retry) → emits additionalContext confirming push landed
 *   - HEAD does not match remote after ~15s retry window → denyPostToolUse (blocks with error)
 *
 * Background push detection: if the Bash tool ran with run_in_background, the tool_response
 * contains "running in background". In that case verification is skipped — the push hasn't
 * completed yet and must be verified via TaskOutput once the background task finishes.
 */

import { denyPostToolUse, GIT_PUSH_RE, git, isShellTool, type ToolHookInput } from "./hook-utils.ts"

interface ExtendedToolHookInput extends ToolHookInput {
  tool_response?: string | null
}

const input = (await Bun.stdin.json()) as ExtendedToolHookInput
if (!input.tool_name || !isShellTool(input.tool_name)) process.exit(0)

const command = String(input.tool_input?.command ?? "")
if (!GIT_PUSH_RE.test(command)) process.exit(0)

// Skip verification for background pushes — the push hasn't completed when PostToolUse fires.
// Background task output must be read via TaskOutput to verify the push succeeded.
const toolResponse = String(input.tool_response ?? "")
if (toolResponse.includes("running in background")) process.exit(0)

const cwd = input.cwd ?? process.cwd()

// Get local HEAD SHA
const localHead = await git(["rev-parse", "HEAD"], cwd)
if (!localHead) process.exit(0) // not a git repo

// Get remote tracking SHA (@{upstream} resolves the tracked remote branch)
const getRemoteHead = async (): Promise<string> => {
  // Fetch latest remote refs before comparing (silent, no stdout spam)
  await git(["fetch", "--quiet"], cwd)
  return (await git(["rev-parse", "@{upstream}"], cwd)) ?? ""
}

const remoteHead = await git(["rev-parse", "@{upstream}"], cwd)
if (!remoteHead) {
  // No upstream configured — nothing to verify against
  process.exit(0)
}

const emitVerified = (msg: string): never => {
  console.log(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } })
  )
  process.exit(0)
}

if (localHead === remoteHead) {
  emitVerified(
    `Push verified: HEAD ${localHead.slice(0, 8)} is confirmed on the remote tracking branch.`
  )
}

// First check failed — could be an in-flight background push.
// Retry with exponential backoff for up to ~15 seconds before blocking.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] // 1s, 2s, 4s, 8s → 15s total
for (const delayMs of RETRY_DELAYS_MS) {
  await Bun.sleep(delayMs)
  const refreshed = await getRemoteHead()
  if (refreshed === localHead) {
    emitVerified(
      `Push verified (after ${delayMs}ms retry): HEAD ${localHead.slice(0, 8)} is confirmed on the remote tracking branch.`
    )
  }
}

// Exhausted retries — HEAD is not on remote
const finalRemote = await getRemoteHead()
denyPostToolUse(
  `Push verification failed: local HEAD (${localHead.slice(0, 8)}) does not match remote tracking branch (${finalRemote.slice(0, 8) || "unknown"}).\n\n` +
    `Checked after retrying for ~15 seconds. Possible causes:\n` +
    `  • The push was rejected (non-fast-forward, branch protection, hook failure)\n` +
    `  • A different branch/ref was pushed than HEAD\n\n` +
    `Run \`git log origin/$(git branch --show-current)..HEAD --oneline\` to see unpushed commits, then push again.`
)
