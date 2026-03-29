#!/usr/bin/env bun

import { allowPreToolUse, denyPreToolUse } from "../src/utils/hook-utils.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "./schemas.ts"

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

function extractInputValues(input: FileEditHookInput): {
  filePath: string
  oldString: string
  newString: string
} | null {
  const ti = input.tool_input ?? {}
  const filePath = String(ti.file_path ?? "")
  const oldString = String(ti.old_string ?? "")
  if (!isEslintConfigFile(filePath) || !oldString) return null
  return { filePath, oldString, newString: String(ti.new_string ?? ti.content ?? "") }
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const values = extractInputValues(input)
  if (!values) process.exit(0)

  checkForWeakening(values.oldString, values.newString)

  const newCounts = countEnforcements(values.newString)
  allowPreToolUse(`ESLint config strength maintained (${newCounts.warnings}w/${newCounts.errors}e)`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
