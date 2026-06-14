#!/usr/bin/env bun

// PreToolUse hook: Mandate that the /generate-requirements skill has been invoked
// in the current session before any Edit/Write to REQUIREMENTS.md is permitted.
//
// REQUIREMENTS.md is the project's product-requirements spec. Editing it ad-hoc
// bypasses the /generate-requirements workflow, which structures scenarios in the
// canonical format and keeps the spec coherent. This gate requires a recent
// /generate-requirements invocation — analogous to /update-memory before editing
// CLAUDE.md in pretooluse-claude-md-update-memory-gate.ts.
//
// Skipped when:
//   - the edit does not target REQUIREMENTS.md
//   - the /generate-requirements skill is not installed for the current agent
//     (skillExistsForHookPayload returns false, which also covers agents without
//      the Skill tool)
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

const GENERATE_REQUIREMENTS_SKILL = "generate-requirements"

/** Basename treated as the requirements spec file. */
const REQUIREMENTS_FILE_PATTERN = "REQUIREMENTS.md"

function isRequirementsFileEdit(input: Record<string, any>): boolean {
  return isFileEditForPath(input, REQUIREMENTS_FILE_PATTERN)
}

function buildDenyReason(ref: string, windowText: string): string {
  return (
    `BLOCKED: editing REQUIREMENTS.md requires the ${ref} skill to be used first.\n\n` +
    `The ${ref} skill has not been invoked recently (${windowText}).\n\n` +
    formatActionPlan([`Invoke the ${ref} skill, then retry this edit.`], {
      header: "To resolve:",
    }) +
    `\nWhy this matters: REQUIREMENTS.md is the project's product-requirements spec. The ` +
    `${ref} skill structures scenarios in the canonical format and keeps the spec coherent. ` +
    `Editing it directly skips these safeguards.`
  )
}

/**
 * Injectable dependency: whether the named skill is installed for the agent that
 * sent this payload. Defaults to the real filesystem-backed lookup; tests stub it
 * so they need not mutate process.cwd() (which races under concurrent test runs).
 */
export type SkillInstalledFn = (skill: string, payload: Record<string, any>) => boolean

export async function evaluateRequirementsGenerateGate(
  rawInput: Record<string, any>,
  skillInstalled: SkillInstalledFn = skillExistsForHookPayload
): Promise<SwizHookOutput> {
  const input = rawInput as {
    tool_name?: string
    tool_input?: { file_path?: string }
    transcript_path?: string
    cwd?: string
  }

  // Only gate Edit/Write operations that target REQUIREMENTS.md.
  if (!isRequirementsFileEdit(input)) return {}

  // Nothing to enforce when the skill is not installed for this agent. This also
  // skips agents without the Skill tool (skillExistsForHookPayload returns false).
  if (!skillInstalled(GENERATE_REQUIREMENTS_SKILL, rawInput)) return {}

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
  const ref = formatSkillReferenceForAgent(GENERATE_REQUIREMENTS_SKILL)
  const windowText = formatCurrentSessionUsageWindow(recencyOptions)

  if (invokedSkills.includes(GENERATE_REQUIREMENTS_SKILL)) {
    return preToolUseAllow(`${ref} skill was invoked recently (${windowText}).`)
  }

  return preToolUseDeny(buildDenyReason(ref, windowText))
}

const pretooluseRequirementsGenerateGate: SwizHook = {
  name: "pretooluse-requirements-generate-gate",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  run: async (rawInput: Record<string, any>): Promise<SwizHookOutput> => {
    try {
      return await evaluateRequirementsGenerateGate(rawInput)
    } catch {
      // Fail open: a detection error must never block legitimate edits.
      return preToolUseAllow("")
    }
  },
}

export default pretooluseRequirementsGenerateGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseRequirementsGenerateGate)
