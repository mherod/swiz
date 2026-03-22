#!/usr/bin/env bun

// PrPoll hook: Fetch new PR notifications and emit them.
// Dispatched by the daemon via `POST /pr-poll` or lefthook via `swiz dispatch prPoll`.
// Uses the blocking strategy — returns notification summary or exits silently.

import { homedir } from "node:os"
import { fetchNewPrNotifications, type PrNotification } from "../src/pr-notify.ts"

function formatNotifications(notifications: PrNotification[]): string {
  if (notifications.length === 0) return ""

  const lines: string[] = [`PR notifications (${notifications.length}):`]
  for (const n of notifications) {
    const repo = n.repository?.full_name ?? "unknown"
    const title = n.subject?.title ?? "untitled"
    const reason = n.reason ?? "unknown"
    lines.push(`  • [${repo}] ${title} (${reason})`)
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
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

  // Emit summary as blocking output for the dispatcher
  const summary = formatNotifications(notifications)
  console.log(JSON.stringify({ decision: "allow", reason: summary }))
  process.exit(0)
}

main().catch(() => {
  // Fail open — don't block on hook errors
  process.exit(0)
})
