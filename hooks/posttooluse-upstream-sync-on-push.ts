#!/usr/bin/env bun

// PostToolUse hook: Trigger a daemon upstream sync after GitHub-mutating shell commands,
// or when the local default branch shows drift versus its remote.
//
// Mutating commands (always sync, no cooldown):
//   - git push       → new commits land; CI may start; PR may update
//   - git pull/fetch → remote state changed; issues/PRs may have been updated
//   - gh pr create   → new PR needs to appear in the store
//   - gh pr merge    → PR closed; linked issues may auto-close
//   - gh pr close    → PR state change
//   - gh issue *     → issue creation, closure, comment, or reopen
//
// Drift detection (cooldown-gated):
//   When the working branch is the repo default (main/master/dev/etc.) and the
//   daemon's cached git state reports ahead > 0 or behind > 0, the local store
//   is likely stale relative to remote. Fire a sync, then suppress further
//   drift-triggered syncs for SYNC_DRIFT_COOLDOWN_MS to avoid spamming the
//   daemon on every Bash invocation.
//
// Fires a POST /projects/sync-now to the daemon (2s client timeout). The daemon
// performs sync in the background; hook returns `{}` either way.
//
// Dual-mode: exports a SwizShellHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { swizUpstreamSyncDriftCooldownPath } from "../src/temp-paths.ts"
import { fetchGitStatusFromDaemon } from "../src/utils/daemon-git-state.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"
import {
  GIT_PUSH_RE,
  GIT_SYNC_RE,
  getCanonicalPathHash,
  git,
  isShellTool,
} from "../src/utils/hook-utils.ts"

const UPSTREAM_MUTATING_RE =
  /\bgh\s+(pr\s+(create|merge|close|edit|reopen|review)|issue\s+(create|close|comment|edit|reopen))\b/i

const GH_API_ISSUE_PATCH_RE = /\bgh\s+api\s+\S*\/(?:issues|pulls)\/\d+\b.*-X\s+PATCH\b/i

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

export const SYNC_DRIFT_COOLDOWN_MS = 60_000

/**
 * Pure predicate: does the current git state indicate the local default-branch
 * checkout has drifted from its remote? Exported for unit testing.
 */
export function isDefaultBranchDrifted(
  status: { branch: string; ahead: number; behind: number } | null,
  defaultBranch: string
): boolean {
  if (!status) return false
  if (status.branch !== defaultBranch) return false
  return status.ahead > 0 || status.behind > 0
}

export function isUpstreamMutatingCommand(command: string): boolean {
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

async function isDriftCooldownActive(repoKey: string): Promise<boolean> {
  try {
    const f = Bun.file(swizUpstreamSyncDriftCooldownPath(repoKey))
    if (!(await f.exists())) return false
    const text = (await f.text()).trim()
    const ts = Number(text)
    if (!Number.isFinite(ts)) return false
    return Date.now() - ts < SYNC_DRIFT_COOLDOWN_MS
  } catch {
    return false
  }
}

async function markDriftCooldown(repoKey: string): Promise<void> {
  try {
    await Bun.write(swizUpstreamSyncDriftCooldownPath(repoKey), String(Date.now()))
  } catch {
    // Non-fatal: if we can't write the sentinel, cooldown simply won't apply.
  }
}

async function maybeTriggerDriftSync(cwd: string): Promise<void> {
  const status = await fetchGitStatusFromDaemon(cwd, { timeoutMs: 300 })
  if (!status) return

  const defaultBranch = await getDefaultBranch(cwd)
  if (!isDefaultBranchDrifted(status, defaultBranch)) return

  const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd)) || cwd
  const repoKey = getCanonicalPathHash(repoRoot)
  if (await isDriftCooldownActive(repoKey)) return

  await markDriftCooldown(repoKey)
  await triggerDaemonSync(cwd)
}

async function evaluate(input: ShellHookInput): Promise<SwizHookOutput> {
  const toolName = input.tool_name ?? ""
  const command = String(input.tool_input?.command ?? "")
  if (!isShellTool(toolName) || !command) return {}

  const cwd = input.cwd ?? process.cwd()

  if (isUpstreamMutatingCommand(command)) {
    await triggerDaemonSync(cwd)
    return {}
  }

  await maybeTriggerDriftSync(cwd)
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
