#!/usr/bin/env bun
// PreToolUse hook: Validate that a .claude/settings.json file contains valid JSON
// before allowing Edit or Write operations on it.

import { allowPreToolUse, denyPreToolUse } from "./utils/hook-utils.ts"

const input = await Bun.stdin.json()
const filePath: string = input?.tool_input?.file_path ?? ""

// Only check .claude/settings.json files
if (!filePath.includes(".claude") || !filePath.endsWith("settings.json")) {
  process.exit(0)
}

let valid = true
try {
  const content = await Bun.file(filePath).text()
  JSON.parse(content)
} catch {
  valid = false
}

if (!valid) {
  denyPreToolUse(
    "Current settings.json contains invalid JSON. Fix the syntax errors first before making further edits.\n\nTip: Run `bun run -i validate-stop-hooks.ts` to see what's broken."
  )
}
allowPreToolUse(`settings.json at ${filePath} contains valid JSON`)
