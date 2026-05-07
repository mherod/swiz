#!/usr/bin/env bun

/**
 * SessionStart hook: softly suggest /weekly-retro on the first session of
 * each ISO week, gated on the last 7 days having ≥3 merged PRs.
 *
 * Gated by `enforceWeeklyRetro` setting (default off, opt-in).
 * Soft suggestion only — no decision/block.
 *
 * See #567.
 */

import { stat, writeFile } from "node:fs/promises"
import { acquireGhSlot } from "../src/gh-rate-limit.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"
import { swizCeremonyDayFlagPath } from "../src/temp-paths.ts"
import { isGitRepo } from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"

const PR_THRESHOLD = 3

function isoWeekKey(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`
}

async function countMergedPrsInLast7Days(cwd: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10)
  await acquireGhSlot()
  const result = await spawnWithTimeout(
    ["gh", "pr", "list", "--state", "merged", "--search", `merged:>=${since}`, "--json", "number"],
    { cwd, timeoutMs: 5000 }
  )
  if (result.exitCode !== 0) return 0
  try {
    const arr = JSON.parse(result.stdout) as unknown[]
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

export async function evaluateSessionstartWeeklyRetroPrompt(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const sentinel = swizCeremonyDayFlagPath("weekly-retro", isoWeekKey())
  try {
    await stat(sentinel)
    return {} // already prompted this ISO week
  } catch {
    // absent — proceed
  }

  const merged = await countMergedPrsInLast7Days(cwd)
  if (merged < PR_THRESHOLD) return {}

  try {
    await writeFile(sentinel, "")
  } catch {
    // best-effort
  }

  return buildContextHookOutput(
    "SessionStart",
    `${merged} PRs merged in the last 7 days but no /weekly-retro this week. Consider running /weekly-retro to surface drift the daily standup cannot see.`
  )
}

const sessionstartWeeklyRetroPrompt: SwizHook = {
  name: "sessionstart-weekly-retro-prompt",
  event: "sessionStart",
  timeout: 10,
  cooldownSeconds: 3600,
  requiredSettings: ["enforceWeeklyRetro"],
  run(input) {
    return evaluateSessionstartWeeklyRetroPrompt(input)
  },
}

export default sessionstartWeeklyRetroPrompt

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartWeeklyRetroPrompt)
}
