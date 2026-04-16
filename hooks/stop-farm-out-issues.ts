#!/usr/bin/env bun

// Stop hook: Block session stop unless the 'farm-out-issues' skill has been invoked
// in the current session.
//
// The /farm-out-issues skill batches and distributes pending issues across sessions.
// Stopping without running it leaves issues untriaged and unassigned.
//
// Dual-mode: exports a SwizStopHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { formatSkillReferenceForAgent, skillAdvice, skillExists } from "../src/skill-utils.ts"
import { getSkillsUsedForCurrentSession } from "../src/transcript-summary.ts"
import { blockStopObj, isGitRepo } from "../src/utils/hook-utils.ts"

/** Human-readable line listing Skill-tool invocations for this session (for hook reason). */
function formatSessionSkillsForReason(skills: string[]): string {
  return `Skills used this session: ${skills.length === 0 ? "(none)" : skills.map((s) => `/${s}`).join(", ")}`
}

export async function evaluateStopFarmOutIssues(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  // Only enforce if the skill is installed on this machine
  if (!skillExists("farm-out-issues")) return {}

  const invokedSkills = await getSkillsUsedForCurrentSession(input)
  const reason = formatSessionSkillsForReason(invokedSkills)
  const skillReferenceForAgent = formatSkillReferenceForAgent("farm-out-issues")

  if (invokedSkills.includes("farm-out-issues")) return {}

  const fallback = [
    `run: Invoke the ${skillReferenceForAgent} skill to batch and distribute pending issues.`,
    `  # ensures no issues are left untriaged or unassigned before the session ends`,
  ].join("\n")

  return blockStopObj(
    `BLOCKED: The ${skillReferenceForAgent} skill has not been invoked in this session.\n\n` +
      `${reason}\n\n` +
      skillAdvice(
        "farm-out-issues",
        `Use the ${skillReferenceForAgent} skill before stopping.`,
        fallback
      ) +
      `\nWhy this matters: the ${skillReferenceForAgent} skill batches and distributes pending issues ` +
      `across sessions. Stopping without running it leaves issues untriaged and unassigned.`
  )
}

const stopFarmOutIssues: SwizStopHook = {
  name: "stop-farm-out-issues",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopFarmOutIssues(input)
  },
}

export default stopFarmOutIssues

if (import.meta.main) {
  await runSwizHookAsMain(stopFarmOutIssues)
}
