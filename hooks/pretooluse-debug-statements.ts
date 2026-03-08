#!/usr/bin/env bun
// PreToolUse hook: Block file writes that introduce new debug statements.
// Detects net-new console.log/debug/trace, debugger keywords in JS/TS source.
// Uses delta check (new count > old count) to avoid false positives when
// editing files that already contain debug statements in unchanged lines.
//
// Allowlists (mirroring stop-debug-statements.ts):
//   - Test files (.test.ts, .spec.ts, __tests__, /test/)
//   - Hook/command infrastructure files (console.log is their output channel)
//   - Generated/minified files
//   - ESLint config files (reference "no-debugger" rule names)

import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  SOURCE_EXT_RE,
  TEST_FILE_RE,
} from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"
import {
  CONFIG_FILE_RE,
  DEBUGGER_RE,
  ESLINT_DEBUGGER_RULE_RE,
  GENERATED_FILE_RE,
  INFRA_FILE_RE,
  JS_COMMENT_RE,
  JS_DEBUG_RE,
  PY_EXCLUDE_RE,
  PY_PRINT_RE,
  RUBY_DEBUG_RE,
} from "./stop-debug-statements.ts"

function countDebugPatterns(content: string): number {
  let count = 0
  for (const line of content.split("\n")) {
    // Skip lines that are pure comments (// console.log etc.)
    if (JS_COMMENT_RE.test(line)) continue
    // Skip ESLint rule references ("no-debugger", "no-console")
    if (ESLINT_DEBUGGER_RULE_RE.test(line)) continue
    // Skip Python noqa / debug-ok annotations
    if (PY_EXCLUDE_RE.test(line)) continue

    if (
      JS_DEBUG_RE.test(line) ||
      DEBUGGER_RE.test(line) ||
      PY_PRINT_RE.test(line) ||
      RUBY_DEBUG_RE.test(line)
    ) {
      count++
    }
  }
  return count
}

export { countDebugPatterns }

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""

  // Only check source files
  if (!SOURCE_EXT_RE.test(filePath)) {
    allowPreToolUse("")
  }

  // Skip allowlisted paths
  if (
    TEST_FILE_RE.test(filePath) ||
    INFRA_FILE_RE.test(filePath) ||
    GENERATED_FILE_RE.test(filePath) ||
    CONFIG_FILE_RE.test(filePath)
  ) {
    allowPreToolUse("")
  }

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  const oldCount = countDebugPatterns(oldString)
  const newCount = countDebugPatterns(newString)

  if (newCount > oldCount) {
    const reason = [
      "Debug statements must not be committed to source files.",
      "",
      "Detected new debug output call(s) being introduced:",
      `  Old: ${oldCount} debug pattern(s) | New: ${newCount} debug pattern(s)`,
      "",
      formatActionPlan(
        [
          "Remove console.log / console.debug / console.trace before writing",
          "Use SWIZ_DEBUG-gated logging: `const debugLog = process.env.SWIZ_DEBUG ? console.error.bind(console) : () => {}`",
          "For permanent structured output, use console.error (not console.log)",
          "Use the debugger in your IDE instead of console.log statements",
        ],
        { header: "Your options:" }
      ).trimEnd(),
    ].join("\n")

    denyPreToolUse(reason)
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
