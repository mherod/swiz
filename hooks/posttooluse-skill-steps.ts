#!/usr/bin/env bun

// PostToolUse hook: After a Skill tool call, extract numbered steps from the
// skill's SKILL.md and create pending tasks for each quality step that
// doesn't already exist as a pending/in_progress task in the session.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { SkillToolInput } from "./schemas.ts"

const posttoolusSkillSteps: SwizHook<SkillToolInput> = {
  name: "posttooluse-skill-steps",
  event: "postToolUse",
  matcher: "Skill",
  timeout: 10,
  async: true,

  async run(input: SkillToolInput): Promise<SwizHookOutput> {
    const toolName: string = input.tool_name ?? ""
    if (toolName !== "Skill") return {}

    const toolInput = input.tool_input
    const skillName: string = toolInput?.skill ?? ""
    const skillArgs: string = toolInput?.args ?? ""
    const sessionId: string = input.session_id ?? ""
    const cwd: string = input.cwd ?? process.cwd()

    if (!skillName || !sessionId) return {}

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
      // Import emitContext dynamically (hook-utils → skill-utils → agents → manifest cycle).
      const { emitContext } = await import("../src/utils/hook-utils.ts")
      await emitContext("PostToolUse", formatSkillStepsSummary(result))
    }

    return {}
  },
}

export default posttoolusSkillSteps

if (import.meta.main) {
  // ─── Standalone execution ────────────────────────────────────────────────────
  await runSwizHookAsMain(posttoolusSkillSteps)
}
