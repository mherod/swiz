#!/usr/bin/env bun
/**
 * PreToolUse hook: Validate that .claude/settings.json contains valid JSON
 * before allowing Edit or Write operations on it.
 *
 * Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
} from "../src/SwizHook.ts"
import type { FileEditHookInput } from "./schemas.ts"

async function evaluate(input: FileEditHookInput) {
  const filePath: string = input.tool_input?.file_path ?? ""

  // Only check .claude/settings.json files
  if (!filePath.includes(".claude") || !filePath.endsWith("settings.json")) {
    return preToolUseAllow("")
  }

  let valid = true
  try {
    const content = await Bun.file(filePath).text()
    JSON.parse(content)
  } catch {
    valid = false
  }

  if (!valid) {
    return preToolUseDeny(
      "Current settings.json contains invalid JSON. Fix the syntax errors first before making further edits.\n\nTip: Run `bun run -i validate-stop-hooks.ts` to see what's broken."
    )
  }
  return preToolUseAllow(`settings.json at ${filePath} contains valid JSON`)
}

const pretoolusJsonValidation: SwizFileEditHook = {
  name: "pretooluse-json-validation",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default pretoolusJsonValidation

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusJsonValidation)
