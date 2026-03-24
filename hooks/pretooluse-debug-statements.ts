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
import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  isExcludedSourcePath,
  TEST_FILE_RE,
} from "./utils/hook-utils.ts"

function isDebugLine(line: string): boolean {
  if (JS_COMMENT_RE.test(line)) return false
  if (ESLINT_DEBUGGER_RULE_RE.test(line)) return false
  if (PY_EXCLUDE_RE.test(line)) return false
  return (
    JS_DEBUG_RE.test(line) ||
    DEBUGGER_RE.test(line) ||
    PY_PRINT_RE.test(line) ||
    RUBY_DEBUG_RE.test(line)
  )
}

function countDebugPatterns(content: string): number {
  return content.split("\n").filter(isDebugLine).length
}

export { countDebugPatterns }

function buildDebugDenyReason(oldCount: number, newCount: number): string {
  return [
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
}

function resolveDebugEditDelta(
  input: ReturnType<typeof fileEditHookInputSchema.parse>
): { oldString: string; newString: string } | null {
  const filePath = input.tool_input?.file_path ?? ""
  if (
    isExcludedSourcePath(filePath, TEST_FILE_RE, INFRA_FILE_RE, GENERATED_FILE_RE, CONFIG_FILE_RE)
  )
    return null
  return {
    oldString: input.tool_input?.old_string ?? "",
    newString: input.tool_input?.new_string ?? input.tool_input?.content ?? "",
  }
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
  const delta = resolveDebugEditDelta(input)
  if (!delta) allowPreToolUse("")

  const oldCount = countDebugPatterns(delta!.oldString)
  const newCount = countDebugPatterns(delta!.newString)

  if (newCount > oldCount) {
    denyPreToolUse(buildDebugDenyReason(oldCount, newCount))
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
