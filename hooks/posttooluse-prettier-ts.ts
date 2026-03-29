#!/usr/bin/env bun

import { dirname } from "node:path"
import { joinNodeModulesPath } from "../src/node-modules-path.ts"
import { emitContext, isFileEditTool } from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "./schemas.ts"

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

function resolveTsEditTarget(input: FileEditHookInput): string | null {
  const toolName = input.tool_name ?? ""
  if (!isFileEditTool(toolName)) return null
  const filePath = input.tool_input?.file_path ?? ""
  if (!filePath || !/\.(ts|tsx)$/.test(filePath)) return null
  return filePath
}

async function runPrettier(prettierBin: string, filePath: string, _cwd: string): Promise<void> {
  try {
    const result = await spawnWithTimeout([prettierBin, "--write", filePath], { timeoutMs: 10_000 })
    if (!result.timedOut && result.exitCode === 0) {
      await emitContext("PostToolUse", `Prettier formatted: ${filePath}`)
    }
  } catch {
    // Prettier crashed — skip silently
  }
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
  const filePath = resolveTsEditTarget(input)
  if (!filePath) process.exit(0)

  const cwd = input.cwd ?? process.cwd()
  const prettierBin = await findPrettier(filePath, cwd)
  if (!prettierBin) process.exit(0)

  await runPrettier(prettierBin, filePath, cwd)
}

if (import.meta.main) main().catch(() => {})
