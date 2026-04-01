#!/usr/bin/env bun

// PrPoll hook: Fetch new PR notifications and emit them.

import { homedir } from "node:os"
import { gh, git } from "../src/git-helpers.ts"
import { fetchNewPrNotifications, type PrNotification, writePrPollState } from "../src/pr-notify.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { hsoContextEvent } from "../src/utils/hook-specific-output.ts"
import { hookOutputSchema, prPollHookInputSchema } from "./schemas.ts"

const BOT_AUTHOR_RE = /^(dependabot|renovate|github-actions|app\/)/i
const BOT_SUFFIX_RE = /\[bot\]$/i

interface EnrichedNotification extends PrNotification {
  prAuthor?: string
}

async function resolvePrAuthor(subjectUrl: string, cwd: string): Promise<string | null> {
  if (!subjectUrl) return null
  try {
    const apiPath = subjectUrl.replace("https://api.github.com", "")
    const login = await gh(["api", apiPath, "--jq", ".user.login"], cwd)
    return login || null
  } catch {
    return null
  }
}

function isBotAuthor(login: string): boolean {
  return BOT_AUTHOR_RE.test(login) || BOT_SUFFIX_RE.test(login)
}

async function enrichAndFilterNotifications(
  notifications: PrNotification[],
  cwd: string
): Promise<EnrichedNotification[]> {
  const enriched: EnrichedNotification[] = []
  for (const n of notifications) {
    const subjectUrl = n.subject?.url ?? ""
    const author = await resolvePrAuthor(subjectUrl, cwd)
    if (author && isBotAuthor(author)) continue
    enriched.push({ ...n, prAuthor: author ?? undefined })
  }
  return enriched
}

function formatNotifications(notifications: EnrichedNotification[]): string {
  return notifications
    .map((n) => {
      const repo = n.repository?.full_name ?? "unknown"
      const title = n.subject?.title ?? "(no title)"
      return `- [${repo}] ${title}`
    })
    .join("\n")
}

async function resolveRepoFullName(cwd: string): Promise<string | null> {
  try {
    const remoteUrl = await git(["remote", "get-url", "origin"], cwd)
    if (!remoteUrl) return null
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export async function evaluatePrpollNotify(input: unknown): Promise<SwizHookOutput> {
  const payload = prPollHookInputSchema.parse(input)
  const cwd = payload.cwd ?? process.cwd()
  const home = homedir()

  let notifications: PrNotification[]
  try {
    notifications = await fetchNewPrNotifications(home)
  } catch {
    return {}
  }

  if (notifications.length === 0) return {}

  const repoFullName = await resolveRepoFullName(cwd)
  const scoped = repoFullName
    ? notifications.filter((n) => n.repository?.full_name === repoFullName)
    : notifications

  if (scoped.length === 0) return {}

  const enriched = await enrichAndFilterNotifications(scoped, cwd)

  if (enriched.length === 0) return {}

  const summary = formatNotifications(enriched)
  await writePrPollState(home, { lastPolledAt: new Date().toISOString() })

  // Top-level `systemMessage` / `reason` for UIs; `hookSpecificOutput.additionalContext`
  // is what `extractContext` aggregates in blocking/context strategies.
  return hookOutputSchema.parse({
    systemMessage: summary,
    reason: summary,
    hookSpecificOutput: hsoContextEvent("prPoll", summary),
  })
}

const prpollNotify: SwizHook<Record<string, any>> = {
  name: "prpoll-notify",
  event: "prPoll",
  scheduled: true,
  timeout: 15,
  run(input) {
    return evaluatePrpollNotify(input)
  },
}

export default prpollNotify

if (import.meta.main) {
  await runSwizHookAsMain(prpollNotify)
}
