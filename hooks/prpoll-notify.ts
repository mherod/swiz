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
import { git } from "./utils/hook-utils.ts"

interface PrPollPayload {
  cwd?: string
}

function formatNotifications(notifications: PrNotification[]): string {
  if (notifications.length === 0) return ""

  const lines: string[] = [`PR notifications (${notifications.length}):`]
  for (const n of notifications) {
    const repo = n.repository?.full_name ?? "unknown"
    const title = n.subject?.title ?? "untitled"
    const reason = n.reason ?? "unknown"
    const updatedAt = n.updated_at ? ` — ${new Date(n.updated_at).toLocaleString()}` : ""
    lines.push(`  • [${repo}] ${title} (${reason}${updatedAt})`)
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

  // Emit summary as blocking output for the dispatcher
  const summary = formatNotifications(scoped)
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
