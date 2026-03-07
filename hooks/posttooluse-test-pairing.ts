#!/usr/bin/env bun
// PostToolUse hook: Remind about sibling test file when editing source files

import { existsSync } from "node:fs"
import { basename, dirname } from "node:path"
import { emitContext, isFileEditTool } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const tool = input.tool_name ?? ""
  const file = (input.tool_input?.file_path as string) ?? ""

  // Only act on edit/write tool calls
  if (!isFileEditTool(tool)) return

  // Only care about TypeScript/JavaScript source files
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file)) return

  // Skip if the file being edited is itself a test file
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__/.test(file)) return

  // Derive candidate test file paths
  const ext = file.split(".").pop()!
  const base = file.replace(/\.[^.]+$/, "")
  const dir = dirname(file)
  const name = basename(base)

  const candidates = [
    `${base}.test.${ext}`,
    `${base}.spec.${ext}`,
    `${dir}/__tests__/${name}.test.${ext}`,
    `${dir}/__tests__/${name}.spec.${ext}`,
  ]

  const foundTest = candidates.find((c) => existsSync(c))
  if (!foundTest) return

  emitContext(
    "PostToolUse",
    `Test file exists for this source file: ${foundTest} — check if it needs updating to reflect your changes.`,
    input.cwd
  )
}

main()
