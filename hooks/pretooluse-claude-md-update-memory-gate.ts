#!/usr/bin/env bun

// PreToolUse hook: Mandate that the /update-memory skill has been invoked in the
// current session before any Edit/Write to a CLAUDE.md memory file is permitted.
//
// CLAUDE.md is the project's memory file. Editing it ad-hoc bypasses the
// /update-memory workflow, which decides what belongs in memory, keeps the file
// focused, and records DO/DON'T rules in the canonical format. This gate requires
// a recent /update-memory invocation — analogous to /commit before `git commit`
// in pretooluse-skill-invocation-gate.ts — but matched on file edits rather than
// shell commands.
//
// Skipped when:
//   - the edit does not target a CLAUDE.md file
//   - the /update-memory skill is not installed for the current agent
//     (skillExistsForHookPayload returns false, which also covers agents without
//      the Skill tool, e.g. Codex which reads SKILL.md directly)
//   - there is no transcript to scan for recent skill usage
//
// Dual-mode: exports a SwizHook for inline dispatch and remains executable as a
// standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "../src/settings/resolution.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"
import { isFileEditForPath } from "../src/utils/edit-projection.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

const UPDATE_MEMORY_SKILL = "update-memory"

function buildDenyReason(ref: string, windowText: string): string {
  return (
    `BLOCKED: editing a CLAUDE.md memory file requires the ${ref} skill to be used first.\n\n` +
    `The ${ref} skill has not been invoked recently (${windowText}).\n\n` +
    formatActionPlan([`Invoke the ${ref} skill, then retry this CLAUDE.md edit.`], {
      header: "To resolve:",
    }) +
    `\nWhy this matters: CLAUDE.md is the project's memory file. The ${ref} skill decides what ` +
    `belongs in memory, keeps the file focused, and records the rule in the canonical format. ` +
    `Editing CLAUDE.md directly skips these safeguards.`
  )
}

/**
 * Injectable dependency: whether the named skill is installed for the agent that
 * sent this payload. Defaults to the real filesystem-backed lookup; tests stub it
 * so they need not mutate process.cwd() (which races under concurrent test runs).
 */
export type SkillInstalledFn = (skill: string, payload: Record<string, any>) => boolean

export async function evaluateClaudeMdUpdateMemoryGate(
  rawInput: Record<string, any>,
  skillInstalled: SkillInstalledFn = skillExistsForHookPayload
): Promise<SwizHookOutput> {
  const input = rawInput as {
    tool_name?: string
    tool_input?: { file_path?: string }
    transcript_path?: string
    cwd?: string
  }

  // Only gate Edit/Write operations that target a CLAUDE.md file.
  if (!isFileEditForPath(input, "CLAUDE.md")) return {}

  // Nothing to enforce when the skill is not installed for this agent. This also
  // skips agents without the Skill tool (skillExistsForHookPayload returns false).
  if (!skillInstalled(UPDATE_MEMORY_SKILL, rawInput)) return {}

  // No transcript to scan — fail open rather than block on missing evidence.
  const transcriptPath = input.transcript_path ?? ""
  if (!transcriptPath) return {}

  const cwd = input.cwd ?? process.cwd()
  const [maxTurns, maxAgeMinutes] = await Promise.all([
    resolveNumericSetting(cwd, "skillRecencyMaxTurns", DEFAULT_SKILL_RECENCY_MAX_TURNS),
    resolveNumericSetting(cwd, "skillRecencyMaxAgeMinutes", DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES),
  ])
  const recencyOptions: CurrentSessionUsageRecencyOptions = {
    maxTurns,
    maxAgeMs: maxAgeMinutes * 60 * 1000,
  }

  const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
  const ref = formatSkillReferenceForAgent(UPDATE_MEMORY_SKILL)
  const windowText = formatCurrentSessionUsageWindow(recencyOptions)

  if (invokedSkills.includes(UPDATE_MEMORY_SKILL)) {
    return preToolUseAllow(`${ref} skill was invoked recently (${windowText}).`)
  }

  return preToolUseDeny(buildDenyReason(ref, windowText))
}

const pretooluseClaudeMdUpdateMemoryGate: SwizHook = {
  name: "pretooluse-claude-md-update-memory-gate",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  run: async (rawInput: Record<string, any>): Promise<SwizHookOutput> => {
    try {
      return await evaluateClaudeMdUpdateMemoryGate(rawInput)
    } catch {
      // Fail open: a detection error must never block legitimate edits.
      return preToolUseAllow("")
    }
  },
}

export default pretooluseClaudeMdUpdateMemoryGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseClaudeMdUpdateMemoryGate)
