#!/usr/bin/env bun

import { fileEditHookInputSchema } from "./schemas.ts"
import { allowPreToolUse, denyPreToolUse } from "./utils/hook-utils.ts"

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

function denyConfigWeakening(kind: string, oldCount: number, newCount: number): never {
  const reason = [
    "ESLint config strength is sacred. Rules cannot be weakened.",
    "",
    `${kind} count decreased from ${oldCount} to ${newCount}.`,
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

function checkForWeakening(oldString: string, newString: string): void {
  const oldCounts = countEnforcements(oldString)
  const newCounts = countEnforcements(newString)
  if (newCounts.warnings < oldCounts.warnings) {
    denyConfigWeakening("Warning", oldCounts.warnings, newCounts.warnings)
  }
  if (newCounts.errors < oldCounts.errors) {
    denyConfigWeakening("Enforcement", oldCounts.errors, newCounts.errors)
  }
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  if (!isEslintConfigFile(filePath)) process.exit(0)

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const oldString = input.tool_input?.old_string ?? ""
  if (!oldString) process.exit(0)

  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""
  checkForWeakening(oldString, newString)

  const newCounts = countEnforcements(newString)
  allowPreToolUse(`ESLint config strength maintained (${newCounts.warnings}w/${newCounts.errors}e)`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
