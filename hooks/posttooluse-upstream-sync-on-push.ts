#!/usr/bin/env bun

// PostToolUse hook: Trigger a daemon upstream sync after GitHub-mutating shell commands.
//
// Detects commands that change remote GitHub state:
//   - git push       → new commits land; CI may start; PR may update
//   - git pull/fetch → remote state changed; issues/PRs may have been updated
//   - gh pr create   → new PR needs to appear in the store
//   - gh pr merge    → PR closed; linked issues may auto-close
//   - gh pr close    → PR state change
//   - gh issue *     → issue creation, closure, comment, or reopen
//
// Fires a POST /projects/sync-now to the daemon (2s client timeout). The daemon
// performs sync in the background; hook returns `{}` either way.
//
// Dual-mode: exports a SwizShellHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import { GIT_PUSH_RE, GIT_SYNC_RE, isShellTool } from "../src/utils/hook-utils.ts"
import type { ShellHookInput } from "./schemas.ts"

const UPSTREAM_MUTATING_RE =
  /\bgh\s+(pr\s+(create|merge|close|edit|reopen)|issue\s+(create|close|comment|edit|reopen))\b/i

const GH_API_ISSUE_PATCH_RE = /\bgh\s+api\s+\S*\/(?:issues|pulls)\/\d+\b.*-X\s+PATCH\b/i

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

function isUpstreamMutatingCommand(command: string): boolean {
  return (
    GIT_PUSH_RE.test(command) ||
    GIT_SYNC_RE.test(command) ||
    UPSTREAM_MUTATING_RE.test(command) ||
    GH_API_ISSUE_PATCH_RE.test(command)
  )
}

async function triggerDaemonSync(cwd: string) {
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 2_000)
    await fetch(`http://127.0.0.1:${DAEMON_PORT}/projects/sync-now`, {
      method: "POST",
      body: JSON.stringify({ cwd }),
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    })
  } catch {
    // Daemon not running or timed out — non-fatal, sync will happen on next interval.
  }
}

async function evaluate(input: ShellHookInput): Promise<SwizHookOutput> {
  const toolName = input.tool_name ?? ""
  const command = String(input.tool_input?.command ?? "")
  if (!isShellTool(toolName) || !command) return {}

  if (!isUpstreamMutatingCommand(command)) return {}

  const cwd = input.cwd ?? process.cwd()
  await triggerDaemonSync(cwd)

  return {}
}

const posttoolusUpstreamSyncOnPush: SwizShellHook = {
  name: "posttooluse-upstream-sync-on-push",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default posttoolusUpstreamSyncOnPush

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusUpstreamSyncOnPush)
}
