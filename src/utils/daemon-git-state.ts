/**
 * Fetch git status summaries from the Swiz daemon's cached `/git/state` endpoint.
 * Falls back to {@link getGitStatusV2} when the daemon is unavailable.
 */

import { getDaemonPort } from "../commands/daemon/daemon-admin.ts"
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

function resolveDaemonEndpointRequest(
  path: string,
  body: Record<string, any>,
  options?: FetchGitStatusFromDaemonOptions
): { url: string; init: RequestInit } {
  const port = options?.port ?? getDaemonPort()
  const signal = options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 500)
  return {
    url: `http://127.0.0.1:${port}${path}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  }
}

async function postDaemonJson<T>(
  path: string,
  body: Record<string, any>,
  options?: FetchGitStatusFromDaemonOptions
): Promise<T | null> {
  const { url, init } = resolveDaemonEndpointRequest(path, body, options)
  try {
    const res = await fetch(url, init)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * POST `{ cwd }` to the daemon `/git/state` endpoint.
 * Returns null when the daemon is down, the response is not OK, or the body lacks `status`.
 */
export async function fetchGitStatusFromDaemon(
  cwd: string,
  options?: FetchGitStatusFromDaemonOptions
): Promise<GitStatusV2 | null> {
  const data = await postDaemonJson<{ status?: Record<string, any> }>(
    "/git/state",
    { cwd },
    options
  )
  return data?.status ? parseDaemonGitStateRecord(data.status) : null
}

export interface DaemonLastUserMessage {
  /** Epoch milliseconds of the most recent user message in the session. */
  at: number
  /** How the daemon learned the time: `hook` is authoritative, `transcript` is a fallback seed. */
  source: "hook" | "transcript"
}

/**
 * Fetch the last user-message time for a session from the daemon's hot in-memory
 * `/sessions/last-user-message` cache. Falls back to a transcript scan inside the
 * daemon when no hook was observed. Returns null when the daemon is unavailable or
 * no user message has been recorded.
 */
export async function fetchLastUserMessageFromDaemon(
  sessionId: string,
  options?: FetchGitStatusFromDaemonOptions & { transcriptPath?: string; cwd?: string }
): Promise<DaemonLastUserMessage | null> {
  const body = {
    sessionId,
    transcriptPath: options?.transcriptPath,
    cwd: options?.cwd,
  }
  const data = await postDaemonJson<Partial<DaemonLastUserMessage>>(
    "/sessions/last-user-message",
    body,
    options
  )
  if (!data || typeof data.at !== "number") return null
  return { at: data.at, source: data.source === "transcript" ? "transcript" : "hook" }
}

/**
 * Fetch session tasks from the daemon's cached `/sessions/tasks` endpoint.
 * Returns the tasks array on success, or null when the daemon is unavailable.
 */
export async function fetchSessionTasksFromDaemon(
  sessionId: string,
  cwd: string,
  options?: FetchGitStatusFromDaemonOptions
): Promise<Array<{ subject: string; status: string }> | null> {
  const data = await postDaemonJson<{ tasks?: Array<{ subject: string; status: string }> }>(
    "/sessions/tasks",
    { sessionId, cwd, limit: 50 },
    options
  )
  return Array.isArray(data?.tasks) ? data.tasks : null
}
