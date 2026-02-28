#!/usr/bin/env bun

import { denyPreToolUse } from "./hook-utils.ts"

interface HookInput {
  tool_name: string
  tool_input?: {
    file_path?: string
    old_string?: string
    new_string?: string
    content?: string
  }
}

// Check if file is an ESLint config file
// Legacy: .eslintrc, .eslintrc.json, .eslintrc.js, .eslintrc.cjs, .eslintrc.yml, .eslintrc.yaml
// Modern flat config: eslint.config.js, eslint.config.mjs, eslint.config.cjs, eslint.config.ts, eslint.config.mts, eslint.config.cts
export function isEslintConfigFile(filePath: string): boolean {
  return /\.eslintrc(\.json|\.js|\.cjs|\.yml|\.yaml)?$|(^|[/\\])eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/.test(
    filePath
  )
}

// Count occurrences of "warning" and "error" (case-insensitive, including severity values)
export function countEnforcements(content: string): { warnings: number; errors: number } {
  const warnings = (content.match(/["']?warning["']?|"warn"|'warn'/gi) || []).length
  const errors = (content.match(/["']?error["']?|"off"|'off'/gi) || []).length
  return { warnings, errors }
}

async function main() {
  const input: HookInput = await Bun.stdin.json()

  const filePath = input.tool_input?.file_path ?? ""
  if (!isEslintConfigFile(filePath)) {
    process.exit(0)
  }

  // Get old and new content
  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  // If no old_string (new file), allow it
  if (!oldString) {
    process.exit(0)
  }

  const oldCounts = countEnforcements(oldString)
  const newCounts = countEnforcements(newString)

  // Check if warning count decreased
  if (newCounts.warnings < oldCounts.warnings) {
    const reason = [
      "ESLint config strength is sacred. Rules cannot be weakened.",
      "",
      `Warning count decreased from ${oldCounts.warnings} to ${newCounts.warnings}.`,
      "",
      "You cannot remove or downgrade ESLint rules. Configuration can only:",
      "  • Add new rules",
      "  • Escalate rules from 'warn' to 'error'",
      "  • Add rule options to be stricter",
      "  • Keep existing rules at their current level",
      "",
      "Weakening ESLint config creates a slippery slope where standards gradually erode.",
      "Once a rule is in place, it stays in place. The codebase quality bar never lowers.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  // Check if error count decreased (off is weaker than error/warning)
  if (newCounts.errors < oldCounts.errors) {
    const reason = [
      "ESLint config strength is sacred. Rules cannot be weakened.",
      "",
      `Enforcement count decreased from ${oldCounts.errors} to ${newCounts.errors}.`,
      "",
      "You cannot disable or downgrade ESLint rules. Configuration can only:",
      "  • Add new rules",
      "  • Escalate rules from 'warn' to 'error'",
      "  • Add rule options to be stricter",
      "  • Keep existing rules at their current level",
      "",
      "Weakening ESLint config creates a slippery slope where standards gradually erode.",
      "Once a rule is in place, it stays in place. The codebase quality bar never lowers.",
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

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
