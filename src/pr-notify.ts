/**
 * PR notification polling logic.
 *
 * Fetches new GitHub notifications for PR activity (reviews, comments)
 * since the last poll timestamp.  State is persisted in
 * ~/.swiz/pr-poll-state.json so the poller never replays old notifications.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// ─── State ───────────────────────────────────────────────────────────────────

export interface PrPollState {
  lastPolledAt: string // ISO 8601
}

export interface PrNotification {
  id: string
  subject: {
    title: string
    url: string
    type: string // "PullRequest" | "Issue" | …
  }
  repository: {
    full_name: string
  }
  reason: string // "review_requested" | "comment" | "mention" | …
  updated_at: string
}

const STATE_FILENAME = "pr-poll-state.json"

function statePath(home: string): string {
  return join(home, ".swiz", STATE_FILENAME)
}

export function readPrPollState(home: string): PrPollState {
  try {
    const raw = readFileSync(statePath(home), "utf8")
    const parsed = JSON.parse(raw) as Partial<PrPollState>
    if (parsed.lastPolledAt) return { lastPolledAt: parsed.lastPolledAt }
  } catch {
    // first run or corrupt file — start from 1 day ago
  }
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString()
  return { lastPolledAt: oneDayAgo }
}

export function writePrPollState(home: string, state: PrPollState): void {
  const path = statePath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

// ─── Fetch notifications ─────────────────────────────────────────────────────

/**
 * Fetch GitHub notifications for PR-related activity since `since`.
 * Returns only notifications with subject.type === "PullRequest".
 *
 * Requires `gh` CLI authenticated.
 */
export async function fetchNewPrNotifications(home: string): Promise<PrNotification[]> {
  const state = readPrPollState(home)
  const since = encodeURIComponent(state.lastPolledAt)

  const proc = Bun.spawn(
    ["gh", "api", `/notifications?all=false&participating=false&since=${since}`],
    { stdout: "pipe", stderr: "pipe" }
  )

  const [stdout, _stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  // Update state regardless of result — avoids replaying on next error recovery
  writePrPollState(home, { lastPolledAt: new Date().toISOString() })

  if (proc.exitCode !== 0) {
    // gh not authenticated or network error — fail silently
    return []
  }

  let all: PrNotification[] = []
  try {
    all = JSON.parse(stdout) as PrNotification[]
  } catch {
    return []
  }

  // Filter to PR-related notifications only
  return all.filter((n) => n.subject?.type === "PullRequest")
}
