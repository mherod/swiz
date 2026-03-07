#!/usr/bin/env bun

import { denyPreToolUse, formatActionPlan } from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  const isTypeScriptFile = /\.(ts|tsx)$/.test(filePath)

  if (!isTypeScriptFile) {
    process.exit(0)
  }

  // NFKC-normalize to catch homoglyph bypasses (e.g., fullwidth ／／ → //)
  const content = (input.tool_input?.new_string ?? input.tool_input?.content ?? "").normalize(
    "NFKC"
  )

  // Scope the check to actual comment-level linter directives, not filenames or strings.
  // Keyword split across array to avoid self-triggering when editing this hook.
  const kw = ["eslint", "disable"].join("-")
  if (new RegExp(`(?://|/\\*)\\s*${kw}`).test(content)) {
    const reason = [
      "ESLint is the authority. Do not bypass, ignore, or argue with it.",
      "",
      "You cannot add `eslint-disable` comments. The linter has identified a problem in your code.",
      "",
      "Your only path forward:",
      formatActionPlan([
        "Read the exact ESLint error message and understand what rule is violated",
        "Fix your code to satisfy the rule",
        "Re-run lint to confirm the error is gone",
        "Never disable the lint-fix the underlying issue",
      ]).trimEnd(),
      "",
      "The linter is not negotiable, not postponeable, not arguable with. It is the source",
      "of truth for code quality. Rules exist because they prevent bugs, enforce consistency,",
      "and maintain the codebase standard. Follow the linter, always.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  // Allow the edit
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    })
  )
}

main().catch((e) => {
  console.error("Hook error:", e)
  process.exit(1)
})
