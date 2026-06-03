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

export function parseTestCommand(segment: string): { isTest: boolean; targets: string[] } {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return { isTest: false, targets: [] }

  let i = 0
  // Skip environment variables set at the beginning, like `NODE_ENV=test PORT=3000 bun test`
  while (i < tokens.length && tokens[i]!.includes("=")) {
    i++
  }

  if (i >= tokens.length) return { isTest: false, targets: [] }

  const cmd = tokens[i]
  i++

  let isTest = false

  if (cmd === "bun") {
    if (i < tokens.length && tokens[i] === "test") {
      isTest = true
      i++ // skip 'test'
    } else if (i < tokens.length && tokens[i] === "run") {
      if (
        i + 1 < tokens.length &&
        (tokens[i + 1] === "test" ||
          tokens[i + 1] === "test:bun" ||
          tokens[i + 1] === "test:vitest")
      ) {
        isTest = true
        i += 2 // skip 'run' and 'test...'
      }
    }
  } else if (cmd === "vitest") {
    isTest = true
    if (i < tokens.length && tokens[i] === "run") {
      i++ // skip 'run'
    }
  } else if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
    if (i < tokens.length && tokens[i] === "test") {
      isTest = true
      i++ // skip 'test'
    } else if (i < tokens.length && tokens[i] === "run") {
      if (i + 1 < tokens.length && tokens[i + 1] === "test") {
        isTest = true
        i += 2 // skip 'run' and 'test'
      }
    }
  }

  if (!isTest) {
    return { isTest: false, targets: [] }
  }

  // Now extract targets
  const targets: string[] = []
  let inDoubleDash = false
  while (i < tokens.length) {
    const token = tokens[i]!
    i++

    if (token === "--") {
      inDoubleDash = true
      continue
    }

    // Ignore flags/options if we haven't seen '--'
    if (!inDoubleDash && token.startsWith("-")) {
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
      // Flags taking values in common test runners
      if (
        !token.includes("=") &&
        [
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
        ].includes(name)
      ) {
        i++ // skip value
      }
      continue
    }

    // Ignore redirections
    if (["1>", "2>", ">", ">>", "<", "2>&1", "2>>", "&>", "1>>"].includes(token)) {
      i++ // skip redirection target
      continue
    }

    // Stop on other shell structures if encountered
    if (["&&", "||", ";", "|", "&"].includes(token)) {
      break
    }

    targets.push(token)
  }

  return { isTest: true, targets }
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
