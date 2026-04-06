#!/usr/bin/env bun

// PostToolUse hook: After a Skill tool call, extract numbered steps from the
// skill's SKILL.md and create pending tasks for each quality step that
// doesn't already exist as a pending/in_progress task in the session.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { SkillToolInput } from "../src/schemas.ts"

function extractSkillParams(input: SkillToolInput) {
  if (input.tool_name !== "Skill") return null
  const skillName = input.tool_input?.skill
  const sessionId = input.session_id
  if (!skillName || !sessionId) return null

  return {
    skillName,
    skillArgs: input.tool_input?.args || "",
    sessionId,
    cwd: input.cwd || process.cwd(),
  }
}

const posttoolusSkillSteps: SwizHook<SkillToolInput> = {
  name: "posttooluse-skill-steps",
  event: "postToolUse",
  matcher: "Skill",
  timeout: 10,
  async: true,

  async run(input: SkillToolInput): Promise<SwizHookOutput> {
    const params = extractSkillParams(input)
    if (!params) return {}

    const { skillName, skillArgs, sessionId, cwd } = params

    // Import skill-steps logic dynamically to avoid circular deps at load time.
    const { createTasksFromSkillSteps, formatSkillStepsSummary } = await import(
      "../src/utils/skill-steps.ts"
    )
    const result = await createTasksFromSkillSteps({
      skillName,
      args: skillArgs,
      sessionId,
      cwd,
    })

    if (result) {
      const { buildContextHookOutput } = await import("../src/utils/hook-utils.ts")
      return buildContextHookOutput("PostToolUse", formatSkillStepsSummary(result))
    }

    return {}
  },
}

export default posttoolusSkillSteps

if (import.meta.main) {
  // ─── Standalone execution ────────────────────────────────────────────────────
  await runSwizHookAsMain(posttoolusSkillSteps)
}
