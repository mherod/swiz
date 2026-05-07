#!/usr/bin/env bun

/**
 * SessionStart hook: softly suggest /morning-standup once per cwd per
 * calendar day when no standup has run today.
 *
 * Gated by `enforceMorningStandup` setting (default off, opt-in).
 * Soft suggestion only — no decision/block.
 *
 * See #567.
 */

import { stat, writeFile } from "node:fs/promises"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"
import { swizCeremonyDayFlagPath } from "../src/temp-paths.ts"
import { isGitRepo } from "../src/utils/hook-utils.ts"

function isoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export async function evaluateSessionstartMorningStandupPrompt(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const sentinel = swizCeremonyDayFlagPath("morning-standup", isoDate())
  try {
    await stat(sentinel)
    return {} // sentinel exists — already prompted (or skill ran) today
  } catch {
    // sentinel absent — fire once
  }

  // Touch sentinel so we don't double-fire if the session restarts later today.
  try {
    await writeFile(sentinel, "")
  } catch {
    // Best-effort — even if we can't write, we still emit the suggestion.
  }

  return buildContextHookOutput(
    "SessionStart",
    "No /morning-standup recorded for this repo today. Consider running it before picking work — it lines up the day's shortlist."
  )
}

const sessionstartMorningStandupPrompt: SwizHook = {
  name: "sessionstart-morning-standup-prompt",
  event: "sessionStart",
  timeout: 5,
  cooldownSeconds: 3600,
  requiredSettings: ["enforceMorningStandup"],
  run(input) {
    return evaluateSessionstartMorningStandupPrompt(input)
  },
}

export default sessionstartMorningStandupPrompt

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartMorningStandupPrompt)
}
