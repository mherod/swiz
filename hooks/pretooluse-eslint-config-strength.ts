#!/usr/bin/env bun

// PreToolUse hook: Block ESLint config changes that weaken enforcement levels.
// Rules can only be added or escalated (warn→error), never removed or downgraded.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
} from "../src/SwizHook.ts"
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

function buildWeakeningMessage(kind: string, oldCount: number, newCount: number): string {
  return [
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

const pretoolusEslintConfigStrength: SwizHook = {
  name: "pretooluse-eslint-config-strength",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, unknown>
    const toolInput = input.tool_input as Record<string, unknown> | undefined
    const filePath = String(toolInput?.file_path ?? "").normalize("NFKC")
    if (!isEslintConfigFile(filePath)) return {}

    const oldString = String(toolInput?.old_string ?? "").normalize("NFKC")
    if (!oldString) return {}

    const newString = String(toolInput?.new_string ?? toolInput?.content ?? "").normalize("NFKC")

    const oldCounts = countEnforcements(oldString)
    const newCounts = countEnforcements(newString)

    if (newCounts.warnings < oldCounts.warnings) {
      return preToolUseDeny(
        buildWeakeningMessage("Warning", oldCounts.warnings, newCounts.warnings)
      )
    }
    if (newCounts.errors < oldCounts.errors) {
      return preToolUseDeny(
        buildWeakeningMessage("Enforcement", oldCounts.errors, newCounts.errors)
      )
    }

    return preToolUseAllow(
      `ESLint config strength maintained (${newCounts.warnings}w/${newCounts.errors}e)`
    )
  },
}

export default pretoolusEslintConfigStrength

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
  const values = extractInputValues(input)
  if (!values) process.exit(0)
  await runSwizHookAsMain(pretoolusEslintConfigStrength)
}
