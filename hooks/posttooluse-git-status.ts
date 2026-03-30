#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { GitStatusV2 } from "../src/utils/git-utils.ts"
import type { ToolHookInput } from "./schemas.ts"

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

function numField(s: Record<string, unknown>, key: string): number {
  const v = s[key]
  return typeof v === "number" ? v : 0
}

/** Map a daemon /git/state response body to a GitStatusV2-compatible object. */
function parseDaemonGitState(s: Record<string, unknown>): GitStatusV2 | null {
  if (typeof s.branch !== "string") return null
  const staged = numField(s, "staged")
  const unstaged = numField(s, "unstaged")
  const untracked = numField(s, "untracked")
  const upstream = typeof s.upstream === "string" ? s.upstream : null
  const upstreamGone = typeof s.upstreamGone === "boolean" ? s.upstreamGone : false
  return {
    branch: s.branch,
    // staged + unstaged may double-count files with mixed staging; acceptable for display
    total: staged + unstaged + untracked,
    modified: staged + unstaged,
    added: 0,
    deleted: 0,
    untracked,
    lines: [],
    ahead: numField(s, "ahead"),
    behind: numField(s, "behind"),
    upstream,
    upstreamGone,
  }
}

/**
 * Try to fetch git status from the daemon's cached /git/state endpoint.
 * Returns a GitStatusV2-compatible object on success, or null if the daemon
 * is unavailable or the response is missing required fields.
 */
async function fetchGitStatusFromDaemon(cwd: string): Promise<GitStatusV2 | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/git/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { status?: Record<string, unknown> } | null
    return data?.status ? parseDaemonGitState(data.status) : null
  } catch {
    return null
  }
}

/**
 * Build the context line from git status data.
 * Exported for unit testing.
 */
export function buildGitContextLine(gitStatus: GitStatusV2, collabMode: string = "auto"): string {
  const { branch, total: uncommitted, ahead, behind, upstream, upstreamGone } = gitStatus

  let status = `[git] branch: ${branch}`

  if (upstreamGone) {
    status += ` | upstream: ${upstream} (gone)`
  } else if (upstream) {
    status += ` | upstream: ${upstream}`
  } else {
    status += ` | no upstream`
  }

  status += ` | uncommitted files: ${uncommitted}`

  if (ahead > 0 && behind > 0) {
    status += ` | diverged: ${ahead} ahead, ${behind} behind`
  } else if (ahead > 0) {
    status += ` | ${ahead} unpushed commit(s)`
  } else if (behind > 0) {
    status += ` | ${behind} behind remote`
  }

  if (collabMode !== "auto") {
    status += ` | collab: ${collabMode}`
  }

  return status
}

const posttoolusGitStatus: SwizHook<ToolHookInput> = {
  name: "posttooluse-git-status",
  event: "postToolUse",
  cooldownSeconds: 60,
  cooldownMode: "always",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const cwd = input.cwd
    if (!cwd) return {}

    const { buildContextHookOutput, isGitRepo, getGitStatusV2 } = await import(
      "../src/utils/hook-utils.ts"
    )
    if (!(await isGitRepo(cwd))) return {}

    // Try daemon cache first to avoid spawning git on every tool call.
    // Falls back to a direct git subprocess when the daemon is unavailable.
    const gitStatus = (await fetchGitStatusFromDaemon(cwd)) ?? (await getGitStatusV2(cwd))
    if (!gitStatus) return {}

    // Prefer dispatcher-provided effective settings; fall back to computing locally.
    const injected = (input as Record<string, unknown>)._effectiveSettings as
      | Record<string, unknown>
      | undefined
    let collabMode: string
    if (injected && typeof injected.collaborationMode === "string") {
      collabMode = injected.collaborationMode
    } else {
      const { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } = await import(
        "../src/settings.ts"
      )
      const [settings, projectSettings] = await Promise.all([
        readSwizSettings(),
        readProjectSettings(cwd),
      ])
      collabMode = getEffectiveSwizSettings(
        settings,
        input.session_id,
        projectSettings
      ).collaborationMode
    }
    const status = buildGitContextLine(gitStatus, collabMode)
    return buildContextHookOutput("PostToolUse", status)
  },
}

export default posttoolusGitStatus

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitStatus)
}
