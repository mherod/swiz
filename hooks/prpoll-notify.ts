#!/usr/bin/env bun

// PrPoll hook: Fetch new PR notifications and emit them.
// Dispatched by the daemon via `POST /pr-poll` or lefthook via `swiz dispatch prPoll`.
// Uses the blocking strategy — returns notification summary or exits silently.
//
// Integration points:
//   1. Scheduled: daemon `POST /pr-poll` dispatches prPoll event periodically.
//   2. Push workflow: `swiz dispatch prPoll` can be called after push to check
//      for new PR activity on the pushed branch.

import { homedir } from "node:os"
import { fetchNewPrNotifications, type PrNotification, writePrPollState } from "../src/pr-notify.ts"
import { git } from "../src/utils/hook-utils.ts"

/** Bot author patterns — these are excluded from notification output. */
const BOT_AUTHOR_RE = /^(dependabot|renovate|github-actions|app\/)/i
const BOT_SUFFIX_RE = /\[bot\]$/i

interface PrPollPayload {
  cwd?: string
}

/** Enriched notification with resolved PR author. */
interface EnrichedNotification extends PrNotification {
  prAuthor?: string
}

/**
 * Resolve PR author from the notification's subject.url.
 * The URL points to the GitHub API PR endpoint (e.g., /repos/owner/repo/pulls/123).
 * Returns the author login or null on failure.
 */
async function resolvePrAuthor(subjectUrl: string): Promise<string | null> {
  if (!subjectUrl) return null
  try {
    // subject.url is already a full API URL — strip the host prefix for gh api
    const apiPath = subjectUrl.replace("https://api.github.com", "")
    const proc = Bun.spawn(["gh", "api", apiPath, "--jq", ".user.login"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) return null
    const login = stdout.trim()
    return login || null
  } catch {
    return null
  }
}

/** Returns true if the login matches a known bot pattern. */
function isBotAuthor(login: string): boolean {
  return BOT_AUTHOR_RE.test(login) || BOT_SUFFIX_RE.test(login)
}

/**
 * Enrich notifications with PR author data and filter out bot-authored PRs.
 * Resolves authors concurrently (max 5 at a time to limit rate impact).
 */
async function enrichAndFilterNotifications(
  notifications: PrNotification[]
): Promise<EnrichedNotification[]> {
  const enriched: EnrichedNotification[] = []

  // Process in batches of 5 to limit concurrent API calls
  const batchSize = 5
  for (let i = 0; i < notifications.length; i += batchSize) {
    const batch = notifications.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (n) => {
        const author = await resolvePrAuthor(n.subject?.url)
        return { ...n, prAuthor: author ?? undefined }
      })
    )
    enriched.push(...results)
  }

  // Filter out bot-authored notifications
  return enriched.filter((n) => !n.prAuthor || !isBotAuthor(n.prAuthor))
}

function formatNotifications(notifications: EnrichedNotification[]): string {
  if (notifications.length === 0) return ""

  const lines: string[] = [`PR notifications (${notifications.length}):`]
  for (const n of notifications) {
    const repo = n.repository?.full_name ?? "unknown"
    const title = n.subject?.title ?? "untitled"
    const reason = n.reason ?? "unknown"
    const author = n.prAuthor ? ` by @${n.prAuthor}` : ""
    const updatedAt = n.updated_at ? ` — ${new Date(n.updated_at).toLocaleString()}` : ""
    lines.push(`  • [${repo}] ${title}${author} (${reason}${updatedAt})`)
  }
  return lines.join("\n")
}

async function parseInput(): Promise<PrPollPayload> {
  try {
    const raw = await new Response(Bun.stdin.stream()).text()
    if (!raw.trim()) return {}
    return JSON.parse(raw) as PrPollPayload
  } catch {
    return {}
  }
}

/** If cwd is a git repo, resolve the GitHub owner/repo to scope notifications. */
async function resolveRepoFullName(cwd: string): Promise<string | null> {
  try {
    const remoteUrl = await git(["remote", "get-url", "origin"], cwd)
    if (!remoteUrl) return null
    // Parse github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const payload = await parseInput()
  const cwd = payload.cwd ?? process.cwd()
  const home = homedir()

  let notifications: PrNotification[]
  try {
    notifications = await fetchNewPrNotifications(home)
  } catch {
    // Fail open — don't block on network/auth errors
    process.exit(0)
  }

  if (notifications.length === 0) {
    process.exit(0)
  }

  // If we know the current repo, filter notifications to it
  const repoFullName = await resolveRepoFullName(cwd)
  const scoped = repoFullName
    ? notifications.filter((n) => n.repository?.full_name === repoFullName)
    : notifications

  if (scoped.length === 0) {
    process.exit(0)
  }

  // Resolve PR authors and filter out bot-authored notifications
  const enriched = await enrichAndFilterNotifications(scoped)

  if (enriched.length === 0) {
    process.exit(0)
  }

  // Emit summary as blocking output for the dispatcher
  const summary = formatNotifications(enriched)
  console.log(JSON.stringify({ decision: "allow", reason: summary }))

  // Advance lastPolledAt only after successfully emitting output.
  // If the hook crashes before this point, notifications are preserved
  // for the next poll rather than silently lost.
  await writePrPollState(home, { lastPolledAt: new Date().toISOString() })
  process.exit(0)
}

main().catch(() => {
  // Fail open — don't block on hook errors
  process.exit(0)
})
