/**
 * PR notification polling logic.
 *
 * Fetches new GitHub notifications for PR activity (reviews, comments)
 * since the last poll timestamp.  State is persisted in
 * ~/.swiz/pr-poll-state.json so the poller never replays old notifications.
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { getPrPollStatePath } from "./settings.ts"

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

export async function readPrPollState(home: string): Promise<PrPollState> {
  const path = getPrPollStatePath(home)
  try {
    if (!path) throw new Error("no home")
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as Partial<PrPollState>
    if (parsed.lastPolledAt) return { lastPolledAt: parsed.lastPolledAt }
  } catch {
    // first run or corrupt file — start from 1 day ago
  }
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString()
  return { lastPolledAt: oneDayAgo }
}

export async function writePrPollState(home: string, state: PrPollState): Promise<void> {
  const path = getPrPollStatePath(home)
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`)
}

// ─── Fetch notifications ─────────────────────────────────────────────────────

/**
 * Fetch GitHub notifications for PR-related activity since `since`.
 * Returns only notifications with subject.type === "PullRequest".
 *
 * Does NOT update lastPolledAt — the caller must call `writePrPollState`
 * after successfully processing the returned notifications. This prevents
 * lost notifications when the caller crashes before emitting output.
 *
 * Requires `gh` CLI authenticated.
 */
export async function fetchNewPrNotifications(home: string): Promise<PrNotification[]> {
  const state = await readPrPollState(home)
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
