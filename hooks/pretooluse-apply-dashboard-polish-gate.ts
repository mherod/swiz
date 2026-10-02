#!/usr/bin/env bun

/** Require dashboard polish before editing TSX files beneath admin/ or dashboard/. */

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
import { extractFileEditTargetPaths, isFileEditTool } from "../src/tool-matchers.ts"

const SKILL_NAME = GATE_REQUIRED_SKILLS.applyDashboardPolish.name
const DASHBOARD_TSX_RE = /(?:^|[/\\])(?:admin|dashboard)[/\\].+\.tsx$/

export function isDashboardPolishGatedFile(filePath: string): boolean {
  return DASHBOARD_TSX_RE.test(filePath)
}

export async function evaluateApplyDashboardPolishGate(
  input: Record<string, any>,
  skillInstalled = skillExistsForHookPayload
): Promise<SwizHookOutput> {
  if (!isFileEditTool(input.tool_name ?? "")) return {}
  const filePath = extractFileEditTargetPaths(input.tool_input).find(isDashboardPolishGatedFile)
  if (!filePath || !skillInstalled(SKILL_NAME, input) || !input.transcript_path) return {}

  const { recencyOptions, windowText } = await resolveSkillRecencyOptions(
    input.cwd ?? process.cwd()
  )
  const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(input, recencyOptions)
  const skillRef = formatSkillReferenceForAgent(SKILL_NAME)

  if (invokedSkills.includes(SKILL_NAME)) {
    return preToolUseAllow(`${skillRef} was invoked recently — dashboard/admin TSX edit allowed.`)
  }

  return preToolUseDeny(
    `BLOCKED: editing ${filePath} requires the ${skillRef} skill.\n\n` +
      `The skill has not been invoked recently (${windowText}).\n\n` +
      `Invoke ${skillRef}, then retry this edit. This applies to .tsx files at any depth ` +
      `beneath an admin/ or dashboard/ directory.`
  )
}

const pretooluseApplyDashboardPolishGate: SwizHook = {
  name: "pretooluse-apply-dashboard-polish-gate",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,
  run: (input) => evaluateApplyDashboardPolishGate(input),
}

export default pretooluseApplyDashboardPolishGate

if (import.meta.main) await runSwizHookAsMain(pretooluseApplyDashboardPolishGate)
