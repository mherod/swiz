#!/usr/bin/env bun

import { join } from "node:path"
import { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { tokenize } from "../src/utils/inline-hook-helpers.ts"
import { splitShellSegments } from "../src/utils/shell-patterns.ts"

const LINT_SCRIPTS = new Set(["lint", "lint:eslint", "lint:fix", "format"])
const BIOME_LINT_COMMANDS = new Set(["check", "ci", "format"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
const LINT_FLAGS_WITH_VALUES = new Set([
  "-c",
  "--config",
  "--ignore-path",
  "--ext",
  "--format",
  "--output-file",
  "--rulesdir",
  "--plugin",
  "--parser",
  "--parser-options",
  "--env",
])
const REDIRECTIONS = new Set(["1>", "2>", ">", ">>", "<", "2>&1", "2>>", "&>", "1>>"])
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"])

function firstCommandIndex(tokens: string[]): number {
  let index = 0
  while (index < tokens.length && tokens[index]!.includes("=")) index++
  return index
}

function packageLintTargetIndex(tokens: string[], commandIndex: number): number | null {
  const subcommand = tokens[commandIndex + 1]
  if (subcommand === "run" && LINT_SCRIPTS.has(tokens[commandIndex + 2] ?? "")) {
    return commandIndex + 3
  }
  return subcommand === "lint" ? commandIndex + 2 : null
}

function lintTargetIndex(tokens: string[], commandIndex: number): number | null {
  const command = tokens[commandIndex]
  if (command === "eslint") return commandIndex + 1
  if (command === "biome") {
    return BIOME_LINT_COMMANDS.has(tokens[commandIndex + 1] ?? "") ? commandIndex + 2 : null
  }
  return command && PACKAGE_MANAGERS.has(command)
    ? packageLintTargetIndex(tokens, commandIndex)
    : null
}

function collectTargets(tokens: string[], startIndex: number): string[] {
  const targets: string[] = []
  let inDoubleDash = false

  for (let index = startIndex; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "--") {
      inDoubleDash = true
    } else if (!inDoubleDash && token.startsWith("-")) {
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
      if (!token.includes("=") && LINT_FLAGS_WITH_VALUES.has(name)) index++
    } else if (REDIRECTIONS.has(token)) {
      index++
    } else if (SHELL_OPERATORS.has(token)) {
      break
    } else {
      targets.push(token)
    }
  }

  return targets
}

export function parseLintCommand(segment: string): { isLint: boolean; targets: string[] } {
  const tokens = tokenize(segment)
  const targetIndex = lintTargetIndex(tokens, firstCommandIndex(tokens))
  return targetIndex === null
    ? { isLint: false, targets: [] }
    : { isLint: true, targets: collectTargets(tokens, targetIndex) }
}

export function isFullLintSuiteRun(command: string): boolean {
  const normalized = normalizeCommand(command)
  const clean = stripHeredocs(normalized)
  const segments = splitShellSegments(clean)

  for (const segment of segments) {
    const { isLint, targets } = parseLintCommand(segment)
    if (isLint) {
      const isFull =
        targets.length === 0 || targets.every((t) => t === "." || t === "./" || t === "./.")
      if (isFull) {
        return true
      }
    }
  }

  return false
}

async function evaluate(input: ShellHookInput) {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command = String(input.tool_input?.command ?? "")
  if (!isFullLintSuiteRun(command)) return {}

  const sessionId = resolveSafeSessionId(input.session_id) || "default"
  const sentinelPath = join(TMP_ROOT, `swiz-lint-start-${sessionId}.json`)

  try {
    await Bun.write(
      sentinelPath,
      JSON.stringify({
        command,
        startTime: Date.now(),
      })
    )
  } catch {
    // Non-fatal
  }

  return {}
}

const pretooluseMeasureLintTime: SwizShellHook = {
  name: "pretooluse-measure-lint-time",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretooluseMeasureLintTime

if (import.meta.main) await runSwizHookAsMain(pretooluseMeasureLintTime)
