#!/usr/bin/env bun

import { dirname } from "node:path"
import { joinNodeModulesPath } from "../src/node-modules-path.ts"
import { fileEditHookInputSchema } from "./schemas.ts"
import { emitContext, isFileEditTool, spawnWithTimeout } from "./utils/hook-utils.ts"

/** Walk up from filePath to find node_modules/.bin/prettier */
async function findPrettier(filePath: string, cwd: string): Promise<string | null> {
  // Check project cwd first
  const cwdBin = joinNodeModulesPath(cwd, ".bin", "prettier")
  if (await Bun.file(cwdBin).exists()) return cwdBin

  // Walk up from file location
  let dir = dirname(filePath)
  for (let i = 0; i < 10; i++) {
    const candidate = joinNodeModulesPath(dir, ".bin", "prettier")
    if (await Bun.file(candidate).exists()) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const toolName = input.tool_name ?? ""
  if (!isFileEditTool(toolName)) process.exit(0)

  const filePath = input.tool_input?.file_path ?? ""
  if (!filePath) process.exit(0)

  if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0)

  const cwd = input.cwd ?? process.cwd()
  const prettierBin = await findPrettier(filePath, cwd)

  // No prettier available — exit silently, no stderr noise
  if (!prettierBin) process.exit(0)

  try {
    const result = await spawnWithTimeout([prettierBin, "--write", filePath], { timeoutMs: 10_000 })
    if (result.timedOut) {
      // Prettier hung — skip silently
    } else if (result.exitCode === 0) {
      await emitContext("PostToolUse", `Prettier formatted: ${filePath}`, cwd)
    }
    // Non-zero exit: skip silently (config issue, parse error, etc.)
  } catch {
    // Prettier crashed — skip silently
  }
}

if (import.meta.main) main().catch(() => {})
