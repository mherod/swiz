#!/usr/bin/env bun
/**
 * prPoll hook: deliver native macOS notifications for new PR activity.
 *
 * Dispatched by the com.swiz.prpoll LaunchAgent every 5 minutes.
 * Reads state from ~/.swiz/pr-poll-state.json; updates it after each run.
 */

import { homedir } from "node:os"
import { fetchNewPrNotifications } from "../src/pr-notify.ts"

const home = homedir()

async function main(): Promise<void> {
  // Resolve swiz-notify binary (same approach as posttooluse-task-notify.ts)
  const swizNotify = Bun.which("swiz-notify")
  if (!swizNotify) {
    // Binary not installed — skip silently
    process.exit(0)
  }

  const notifications = await fetchNewPrNotifications(home)

  for (const notif of notifications) {
    const repo = notif.repository.full_name
    const title = notif.subject.title
    const reason = notif.reason // "review_requested" | "comment" | "mentioned" | …

    // Map reason to a concise prefix
    let prefix: string
    if (reason === "review_requested") {
      prefix = "Review requested"
    } else if (reason === "comment") {
      prefix = "New comment"
    } else if (reason === "mention") {
      prefix = "Mentioned"
    } else {
      prefix = "PR update"
    }

    const body = `${prefix}: ${title}`

    Bun.spawnSync([
      swizNotify,
      "--title",
      repo,
      "--body",
      body,
      "--sound",
      "Glass",
      "--timeout",
      "5",
    ])
  }
}

main().catch((err) => {
  console.error("[prpoll-notify]", err)
  process.exit(0)
})
