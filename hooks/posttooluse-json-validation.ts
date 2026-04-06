#!/usr/bin/env bun

// PostToolUse hook: Validate JSON files after writing

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { buildDenyPostToolUseOutput } from "../src/utils/hook-utils.ts"

export async function evaluatePosttooluseJsonValidation(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const filePath = hookInput.tool_input?.file_path as string | undefined

  if (!filePath || !filePath.endsWith(".json")) return {}

  try {
    const content = await Bun.file(filePath).text()
    JSON.parse(content)
  } catch {
    return buildDenyPostToolUseOutput(
      "JSON validation failed — the file is not valid JSON. Fix the syntax errors."
    )
  }

  return {}
}

const posttooluseJsonValidation: SwizHook<Record<string, any>> = {
  name: "posttooluse-json-validation",
  event: "postToolUse",
  matcher: "Edit|Write",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseJsonValidation(input)
  },
}

export default posttooluseJsonValidation

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseJsonValidation)
}
