#!/usr/bin/env bun

import { dirname } from "node:path"
import { joinNodeModulesPath } from "../src/node-modules-path.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { buildContextHookOutput, isFileEditTool } from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "./schemas.ts"

async function findPrettier(filePath: string, cwd: string): Promise<string | null> {
  const cwdBin = joinNodeModulesPath(cwd, ".bin", "prettier")
  if (await Bun.file(cwdBin).exists()) return cwdBin

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

async function runPrettier(prettierBin: string, filePath: string): Promise<SwizHookOutput> {
  try {
    const result = await spawnWithTimeout([prettierBin, "--write", filePath], { timeoutMs: 10_000 })
    if (!result.timedOut && result.exitCode === 0) {
      return buildContextHookOutput("PostToolUse", `Prettier formatted: ${filePath}`)
    }
  } catch {
    // Prettier crashed — skip silently
  }
  return {}
}

export async function evaluatePosttoolusePrettierTs(input: unknown): Promise<SwizHookOutput> {
  const hookInput = fileEditHookInputSchema.parse(input)
  const filePath = resolveTsEditTarget(hookInput)
  if (!filePath) return {}

  const cwd = hookInput.cwd ?? process.cwd()
  const prettierBin = await findPrettier(filePath, cwd)
  if (!prettierBin) return {}

  return await runPrettier(prettierBin, filePath)
}

const posttoolusePrettierTs: SwizHook<Record<string, any>> = {
  name: "posttooluse-prettier-ts",
  event: "postToolUse",
  matcher: "Edit|Write",
  timeout: 5,
  async: true,
  run(input) {
    return evaluatePosttoolusePrettierTs(input)
  },
}

export default posttoolusePrettierTs

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusePrettierTs)
}
