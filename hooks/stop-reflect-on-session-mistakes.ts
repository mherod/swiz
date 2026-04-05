#!/usr/bin/env bun

// Stop hook: Block stop until the /reflect-on-session-mistakes skill has been
// invoked in the current session.
//
// This is the stop-side backstop for the reflection workflow. If the skill is
// available but has not yet been used, the session is not allowed to end until
// the agent performs the explicit reflection pass.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getSkillsUsedForCurrentSession } from "../src/transcript-summary.ts"
import {
  blockStopObj,
  formatActionPlan,
  skillAdvice,
  skillExists,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

function formatSessionSkillsForReason(skills: string[]): string {
  if (skills.length === 0) return "Skills used this session: (none)"
  return `Skills used this session: ${skills.map((s) => `/${s}`).join(", ")}`
}

export async function evaluateStopReflectOnSessionMistakesHook(
  input: StopHookInput
): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)

  // Fail open when the skill is unavailable on this machine. There is nothing
  // to enforce if the agent cannot invoke the skill at all.
  if (!skillExists("reflect-on-session-mistakes")) return {}

  const invokedSkills = await getSkillsUsedForCurrentSession(parsed)
  if (invokedSkills.includes("reflect-on-session-mistakes")) return {}

  const reflectAdvice = skillAdvice(
    "reflect-on-session-mistakes",
    "run /reflect-on-session-mistakes to identify patterns to avoid",
    "review the session transcript for patterns to avoid"
  )

  return blockStopObj(
    `BLOCKED: stop requires the /reflect-on-session-mistakes skill to be used first.\n\n` +
      `${formatSessionSkillsForReason(invokedSkills)}\n\n` +
      formatActionPlan([reflectAdvice], {
        header: "The /reflect-on-session-mistakes skill has not been invoked in this session:",
      }) +
      `\nWhy this matters: session reflection captures the mistakes before the session ends and ` +
      `keeps the follow-up memory/update workflow grounded in concrete evidence.`
  )
}

const stopReflectOnSessionMistakes: SwizStopHook = {
  name: "stop-reflect-on-session-mistakes",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopReflectOnSessionMistakesHook(input)
  },
}

export default stopReflectOnSessionMistakes

if (import.meta.main) {
  await runSwizHookAsMain(stopReflectOnSessionMistakes)
}
