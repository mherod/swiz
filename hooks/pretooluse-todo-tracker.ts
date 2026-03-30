#!/usr/bin/env bun
/**
 * PreToolUse hook: Block file edits that introduce new TODO/FIXME/HACK debt markers.
 *
 * Mirrors stop-todo-tracker.ts semantics — only net-new additions are blocked.
 * Uses a delta check (newCount > oldCount) so editing files that already contain
 * TODO comments doesn't trigger false positives.
 *
 * Exclusions (matching the stop hook): non-source files, hooks/, node_modules,
 * .claude/hooks/, test files, generated files, regex literals, non-comment contexts.
 */

import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  resolveEditDelta,
  TEST_FILE_RE,
} from "../src/utils/hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"
import { EXCLUDE_PATH_RE, GENERATED_FILE_RE } from "./stop-todo-tracker.ts"

const DEBT_MARKER_RE = new RegExp(
  "\\b(" +
    ["TO" + "DO", "FIX" + "ME", "HA" + "CK", "X" + "XX", "WORK" + "AROUND"].join("|") +
    ")\\b",
  "i"
)
const COMMENT_RE = /(\/[/*]|#\s)/
const REGEX_LITERAL_RE = /^\s*\/[^/*]/ // line starts with a regex literal (not // or /* comment)

function countTodoMarkers(content: string): number {
  let count = 0
  for (const line of content.split("\n")) {
    if (!DEBT_MARKER_RE.test(line)) continue
    if (REGEX_LITERAL_RE.test(line)) continue
    if (!COMMENT_RE.test(line)) continue
    count++
  }
  return count
}

export { countTodoMarkers }

function buildDenyMessage(oldCount: number, newCount: number): string {
  return [
    "TODO/FIXME/HACK debt markers must not be introduced in source files.",
    "",
    `Detected ${newCount - oldCount} new debt marker(s):`,
    `  Old: ${oldCount} marker(s) | New: ${newCount} marker(s)`,
    "",
    formatActionPlan(
      [
        "Remove the debt marker comment before writing",
        "If this is real follow-up work, create a GitHub issue instead: gh issue create",
        "Use the /farm-out-issues skill to convert inline markers into tracked issues",
        "If the marker is already in the file (not new), verify old_string captures it",
      ],
      { header: "Your options:" }
    ).trimEnd(),
  ].join("\n")
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
  const delta = resolveEditDelta(input, EXCLUDE_PATH_RE, GENERATED_FILE_RE, TEST_FILE_RE)
  if (!delta) allowPreToolUse("")

  const oldCount = countTodoMarkers(delta!.oldString)
  const newCount = countTodoMarkers(delta!.newString)
  const netNew = newCount - oldCount

  if (netNew > 0) {
    denyPreToolUse(buildDenyMessage(oldCount, newCount))
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
