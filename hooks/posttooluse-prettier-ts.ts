#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { isFileEditTool } from "./hook-utils.ts"

interface HookInput {
  cwd: string
  tool_name: string
  tool_input?: {
    file_path?: string
  }
}

/** Walk up from filePath to find node_modules/.bin/prettier */
function findPrettier(filePath: string, cwd: string): string | null {
  // Check project cwd first
  const cwdBin = join(cwd, "node_modules", ".bin", "prettier")
  if (existsSync(cwdBin)) return cwdBin

  // Walk up from file location
  let dir = dirname(filePath)
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "node_modules", ".bin", "prettier")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function main() {
  const input: HookInput = await Bun.stdin.json()

  const toolName = input.tool_name ?? ""
  if (!isFileEditTool(toolName)) process.exit(0)

  const filePath = input.tool_input?.file_path ?? ""
  if (!filePath) process.exit(0)

  if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0)

  const cwd = input.cwd ?? process.cwd()
  const prettierBin = findPrettier(filePath, cwd)

  // No prettier available — exit silently, no stderr noise
  if (!prettierBin) process.exit(0)

  try {
    const proc = Bun.spawn([prettierBin, "--write", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited

    if (proc.exitCode === 0) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `Prettier formatted: ${filePath}`,
          },
        })
      )
    }
    // Non-zero exit: skip silently (config issue, parse error, etc.)
  } catch {
    // Prettier crashed — skip silently
  }
}

main().catch(() => {})
