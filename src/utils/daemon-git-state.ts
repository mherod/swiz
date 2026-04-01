/**
 * Fetch git status summaries from the Swiz daemon's cached `/git/state` endpoint.
 * Falls back to {@link getGitStatusV2} when the daemon is unavailable.
 */

import type { GitStatusV2 } from "./git-utils.ts"

function numField(s: Record<string, any>, key: string): number {
  const v = s[key]
  return typeof v === "number" ? v : 0
}

/**
 * Map a daemon `/git/state` response `status` object to {@link GitStatusV2}.
 * Returns null when required fields are missing.
 */
export function parseDaemonGitStateRecord(s: Record<string, any>): GitStatusV2 | null {
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

export interface FetchGitStatusFromDaemonOptions {
  /** Defaults to `SWIZ_DAEMON_PORT` or 7943. */
  port?: number
  /** Defaults to `AbortSignal.timeout(timeoutMs)`. */
  signal?: AbortSignal
  /** Timeout when `signal` is omitted. Default 500ms. */
  timeoutMs?: number
}

/**
 * POST `{ cwd }` to the daemon `/git/state` endpoint.
 * Returns null when the daemon is down, the response is not OK, or the body lacks `status`.
 */
export async function fetchGitStatusFromDaemon(
  cwd: string,
  options?: FetchGitStatusFromDaemonOptions
): Promise<GitStatusV2 | null> {
  const port = options?.port ?? (Number(process.env.SWIZ_DAEMON_PORT) || 7943)
  const signal = options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/git/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
      signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { status?: Record<string, any> } | null
    return data?.status ? parseDaemonGitStateRecord(data.status) : null
  } catch {
    return null
  }
}
