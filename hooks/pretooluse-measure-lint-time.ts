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

export function parseLintCommand(segment: string): { isLint: boolean; targets: string[] } {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return { isLint: false, targets: [] }

  let i = 0
  // Skip environment variables set at the beginning, like `NODE_ENV=production eslint .`
  while (i < tokens.length && tokens[i]!.includes("=")) {
    i++
  }

  if (i >= tokens.length) return { isLint: false, targets: [] }

  const cmd = tokens[i]
  i++

  let isLint = false

  if (cmd === "biome") {
    if (
      i < tokens.length &&
      (tokens[i] === "check" || tokens[i] === "ci" || tokens[i] === "format")
    ) {
      isLint = true
      i++
    }
  } else if (cmd === "eslint") {
    isLint = true
  } else if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "bun") {
    if (i < tokens.length && tokens[i] === "run") {
      if (
        i + 1 < tokens.length &&
        (tokens[i + 1] === "lint" ||
          tokens[i + 1] === "lint:eslint" ||
          tokens[i + 1] === "lint:fix" ||
          tokens[i + 1] === "format")
      ) {
        isLint = true
        i += 2
      }
    } else if (i < tokens.length && tokens[i] === "lint") {
      isLint = true
      i++
    }
  }

  if (!isLint) {
    return { isLint: false, targets: [] }
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
      // Flags taking values in eslint / biome
      if (
        !token.includes("=") &&
        [
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

  return { isLint: true, targets }
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
