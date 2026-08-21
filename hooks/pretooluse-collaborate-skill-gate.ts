#!/usr/bin/env bun

/**
 * PreToolUse hook: require the /collaborate-with-another-agent skill before SendMessage.
 *
 * SendMessage addresses a live peer session. Messaging one without the coordination
 * protocol — peer discovery, lane claims, collision recovery — is how two sessions end
 * up writing the same files. The skill is the protocol, so it must be active first.
 *
 * Fails open when the skill is not installed on this machine, or when the transcript
 * path is missing (recency cannot be determined).
 *
 * Dual-mode: exports a SwizHook for inline dispatch and remains executable as a
 * standalone script for backwards compatibility and testing.
 */

import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import {
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  resolveSkillRecencyOptions,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"

const SKILL_NAME = GATE_REQUIRED_SKILLS.collaborateWithAnotherAgent.name

function formatInvokedSkills(skills: string[]): string {
  return skills.length === 0 ? "(none)" : skills.map((skill) => `/${skill}`).join(", ")
}

export async function evaluateCollaborateSkillGate(
  input: Record<string, unknown>
): Promise<SwizHookOutput> {
  if (!skillExistsForHookPayload(SKILL_NAME, input)) return {}

  const transcriptPath = (input.transcript_path as string | undefined) ?? ""
  if (!transcriptPath) return {}

  const cwd = (input.cwd as string | undefined) ?? process.cwd()
  const { recencyOptions, windowText: window } = await resolveSkillRecencyOptions(cwd)
  const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(input, recencyOptions)
  const skillRef = formatSkillReferenceForAgent(SKILL_NAME)

  if (invokedSkills.includes(SKILL_NAME)) {
    return preToolUseAllow(`${skillRef} was invoked recently — peer message allowed.`)
  }

  return preToolUseDeny(
    `BLOCKED: SendMessage requires the ${skillRef} skill.\n\n` +
      `Skills used recently (${window}): ${formatInvokedSkills(invokedSkills)}\n\n` +
      `Invoke ${skillRef} before messaging another agent session. It covers peer discovery, ` +
      `lane claims across shared writable surfaces, and collision recovery — messaging a peer ` +
      `without that protocol is how two sessions overwrite each other's work.`
  )
}

const pretooluseCollaborateSkillGate: SwizHook = {
  name: "pretooluse-collaborate-skill-gate",
  event: "preToolUse",
  matcher: "SendMessage",
  timeout: 5,

  run: evaluateCollaborateSkillGate,
}

export default pretooluseCollaborateSkillGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseCollaborateSkillGate)
