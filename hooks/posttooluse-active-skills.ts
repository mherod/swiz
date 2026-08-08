#!/usr/bin/env bun

/** PostToolUse hook: refresh context for skills active in the configured recency window. */

import { resolveActiveSkillsContext } from "../src/active-skills-context.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"

export async function evaluatePosttooluseActiveSkills(
  input: ToolHookInput
): Promise<SwizHookOutput> {
  const context = await resolveActiveSkillsContext(input)
  return context ? buildContextHookOutput("PostToolUse", context) : {}
}

const posttooluseActiveSkills: SwizHook<ToolHookInput> = {
  name: "posttooluse-active-skills",
  event: "postToolUse",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseActiveSkills(input)
  },
}

export default posttooluseActiveSkills

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseActiveSkills)
}
