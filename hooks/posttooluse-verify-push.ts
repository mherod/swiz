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
 *   - No upstream tracking branch → exit 0 (untracked branch; push-cooldown handles it)
 *   - HEAD matches remote → emits additionalContext confirming push landed
 *   - HEAD does not match remote → denyPostToolUse (blocks with error)
 */

import { denyPostToolUse, GIT_PUSH_RE, git, isShellTool, type ToolHookInput } from "./hook-utils.ts"

const input = (await Bun.stdin.json()) as ToolHookInput
if (!input.tool_name || !isShellTool(input.tool_name)) process.exit(0)

const command = String(input.tool_input?.command ?? "")
if (!GIT_PUSH_RE.test(command)) process.exit(0)

const cwd = input.cwd ?? process.cwd()

// Get local HEAD SHA
const localHead = await git(["rev-parse", "HEAD"], cwd)
if (!localHead) process.exit(0) // not a git repo

// Get remote tracking SHA (@{upstream} resolves the tracked remote branch)
const remoteHead = await git(["rev-parse", "@{upstream}"], cwd)
if (!remoteHead) {
  // No upstream configured — nothing to verify against
  process.exit(0)
}

if (localHead === remoteHead) {
  // Push confirmed: HEAD is on the remote tracking branch
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Push verified: HEAD ${localHead.slice(0, 8)} is confirmed on the remote tracking branch.`,
      },
    })
  )
  process.exit(0)
}

// HEAD is not on remote — push did not land
denyPostToolUse(
  `Push verification failed: local HEAD (${localHead.slice(0, 8)}) does not match remote tracking branch (${remoteHead.slice(0, 8)}).\n\n` +
    `The push command ran but the commit is not confirmed on the remote. Possible causes:\n` +
    `  • The push was rejected (non-fast-forward, branch protection, hook failure)\n` +
    `  • A different branch/ref was pushed than HEAD\n` +
    `  • The push is still in-flight (background task not yet complete)\n\n` +
    `Run \`git log origin/$(git branch --show-current)..HEAD --oneline\` to see unpushed commits, then push again.`
)
