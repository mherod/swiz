#!/usr/bin/env bun

/** PreToolUse hook: surface skills that remain active in the configured recency window. */

import { resolveActiveSkillsContext } from "../src/active-skills-context.ts"
import {
  preToolUseAllowWithContext,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"

export async function evaluatePretooluseActiveSkills(
  input: ToolHookInput
): Promise<SwizHookOutput> {
  const context = await resolveActiveSkillsContext(input, { includeVerifiedSkillPaths: true })
  return context ? preToolUseAllowWithContext("", context, { rephrase: false }) : {}
}

const pretooluseActiveSkills: SwizToolHook = {
  name: "pretooluse-active-skills",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretooluseActiveSkills(input)
  },
}

export default pretooluseActiveSkills

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseActiveSkills)
}
