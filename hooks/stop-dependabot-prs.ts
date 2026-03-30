#!/usr/bin/env bun
// Stop hook: Surfaces open Dependabot PRs and blocks stop when any are older than 7 days.
// Reuses isAutomationLogin() from collaboration-policy.ts for Dependabot detection.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { isAutomationLogin } from "../src/collaboration-policy.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import {
  blockStopObj,
  ghJson,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const STALE_DAYS = 7
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

interface DependabotPr {
  number: number
  title: string
  url: string
  headRefName: string
  createdAt: string
  author: { login: string }
}

function ageDays(createdAt: string, now: number): number {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return 0
  return Math.floor((now - created) / (24 * 60 * 60 * 1000))
}

export async function evaluateStopDependabotPrs(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}
  if (!(await isGitHubRemote(cwd))) return {}
  if (!hasGhCli()) return {}

  const prs = await ghJson<DependabotPr[]>(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,url,headRefName,createdAt,author",
      "--limit",
      "20",
    ],
    cwd
  )
  if (!prs || prs.length === 0) return {}

  const now = Date.now()
  const dependabotPrs = prs.filter((pr) => pr.author?.login && isAutomationLogin(pr.author.login))
  if (dependabotPrs.length === 0) return {}

  const stalePrs = dependabotPrs.filter((pr) => now - Date.parse(pr.createdAt) > STALE_MS)
  if (stalePrs.length === 0) return {}

  const lines = [
    `${stalePrs.length} open Dependabot PR(s) older than ${STALE_DAYS} days need attention:`,
    "",
  ]
  for (const pr of stalePrs) {
    const age = ageDays(pr.createdAt, now)
    lines.push(`  #${pr.number}: ${pr.title} (${age}d old)`)
    lines.push(`    ${pr.url}`)
  }
  lines.push("")
  lines.push("Next steps for each PR:")
  lines.push("  • Review and merge:  gh pr merge <number> --squash")
  lines.push("  • Close if superseded:  gh pr close <number>")
  lines.push("  • Checkout to inspect:  gh pr checkout <number>")

  return blockStopObj(lines.join("\n"), { includeUpdateMemoryAdvice: false })
}

const stopDependabotPrs: SwizStopHook = {
  name: "stop-dependabot-prs",
  event: "stop",
  timeout: 10,
  cooldownSeconds: 3600,

  run(input) {
    return evaluateStopDependabotPrs(input)
  },
}

export default stopDependabotPrs

if (import.meta.main) {
  await runSwizHookAsMain(stopDependabotPrs)
}
