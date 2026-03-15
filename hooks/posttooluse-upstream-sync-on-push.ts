#!/usr/bin/env bun
// PostToolUse hook: Trigger a daemon upstream sync after GitHub-mutating shell commands.
//
// Detects commands that change remote GitHub state:
//   - git push       → new commits land; CI may start; PR may update
//   - gh pr create   → new PR needs to appear in the store
//   - gh pr merge    → PR closed; linked issues may auto-close
//   - gh pr close    → PR state change
//   - gh issue *     → issue creation, closure, comment, or reopen
//
// Fires a non-blocking POST /projects/sync-now to the daemon so the IssueStore
// reflects the new state on the agent's next read.  The hook exits immediately;
// sync happens in the daemon background.

import { GIT_PUSH_RE, isShellTool } from "./hook-utils.ts"

const UPSTREAM_MUTATING_RE =
  /\bgh\s+(pr\s+(create|merge|close|edit|reopen)|issue\s+(create|close|comment|edit|reopen))\b/i

// Matches REST PATCH calls that mutate issue/PR state:
//   gh api repos/owner/repo/issues/42 -X PATCH -f state=closed
//   gh api repos/:owner/:repo/pulls/7 -X PATCH -f state=closed
const GH_API_ISSUE_PATCH_RE = /\bgh\s+api\s+\S*\/(?:issues|pulls)\/\d+\b.*-X\s+PATCH\b/i

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
const cwd: string = input.cwd ?? process.cwd()
const command: string = input.tool_input?.command ?? ""

if (!isShellTool(toolName) || !command) process.exit(0)

const shouldSync =
  GIT_PUSH_RE.test(command) ||
  UPSTREAM_MUTATING_RE.test(command) ||
  GH_API_ISSUE_PATCH_RE.test(command)
if (!shouldSync) process.exit(0)

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

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
