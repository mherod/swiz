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

const BUN_TEST_SCRIPTS = new Set(["test", "test:bun", "test:vitest"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"])
const TEST_FLAGS_WITH_VALUES = new Set([
  "-t",
  "--timeout",
  "-r",
  "--reporter",
  "-c",
  "--config",
  "--filter",
  "--preload",
  "--testNamePattern",
  "-o",
  "--outputFile",
  "--workspace",
])
const REDIRECTIONS = new Set(["1>", "2>", ">", ">>", "<", "2>&1", "2>>", "&>", "1>>"])
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"])

function firstCommandIndex(tokens: string[]): number {
  let index = 0
  while (index < tokens.length && tokens[index]!.includes("=")) index++
  return index
}

function packageTestTargetIndex(tokens: string[], commandIndex: number): number | null {
  const subcommand = tokens[commandIndex + 1]
  if (subcommand === "test") return commandIndex + 2
  return subcommand === "run" && tokens[commandIndex + 2] === "test" ? commandIndex + 3 : null
}

function bunTestTargetIndex(tokens: string[], commandIndex: number): number | null {
  const subcommand = tokens[commandIndex + 1]
  if (subcommand === "test") return commandIndex + 2
  if (subcommand === "run" && BUN_TEST_SCRIPTS.has(tokens[commandIndex + 2] ?? "")) {
    return commandIndex + 3
  }
  return null
}

function testTargetIndex(tokens: string[], commandIndex: number): number | null {
  const command = tokens[commandIndex]
  if (command === "bun") return bunTestTargetIndex(tokens, commandIndex)
  if (command === "vitest") {
    return tokens[commandIndex + 1] === "run" ? commandIndex + 2 : commandIndex + 1
  }
  return command && PACKAGE_MANAGERS.has(command)
    ? packageTestTargetIndex(tokens, commandIndex)
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
      if (!token.includes("=") && TEST_FLAGS_WITH_VALUES.has(name)) index++
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

export function parseTestCommand(segment: string): { isTest: boolean; targets: string[] } {
  const tokens = tokenize(segment)
  const targetIndex = testTargetIndex(tokens, firstCommandIndex(tokens))
  return targetIndex === null
    ? { isTest: false, targets: [] }
    : { isTest: true, targets: collectTargets(tokens, targetIndex) }
}

export function isFullTestSuiteRun(command: string): boolean {
  const normalized = normalizeCommand(command)
  const clean = stripHeredocs(normalized)
  const segments = splitShellSegments(clean)

  for (const segment of segments) {
    const { isTest, targets } = parseTestCommand(segment)
    if (isTest) {
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
  if (!isFullTestSuiteRun(command)) return {}

  const sessionId = resolveSafeSessionId(input.session_id) || "default"
  const sentinelPath = join(TMP_ROOT, `swiz-test-start-${sessionId}.json`)

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

const pretooluseMeasureTestTime: SwizShellHook = {
  name: "pretooluse-measure-test-time",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretooluseMeasureTestTime

if (import.meta.main) await runSwizHookAsMain(pretooluseMeasureTestTime)
