#!/usr/bin/env bun
// PostToolUse hook: Remind about sibling test file when editing source files

import { stat } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { toolHookInputSchema } from "./schemas.ts"
import { emitContext, isFileEditTool, scheduleAutoSteer } from "./utils/hook-utils.ts"

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs)$/
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__/
const COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

async function findSiblingTest(file: string): Promise<string | undefined> {
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

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate
  }
  return undefined
}

async function isTestFileStale(testPath: string): Promise<boolean> {
  try {
    const testStat = await stat(testPath)
    return Date.now() - testStat.mtimeMs >= COOLDOWN_MS
  } catch {
    return false
  }
}

function resolveEditTarget(input: ReturnType<typeof toolHookInputSchema.parse>): string | null {
  const tool = input.tool_name ?? ""
  const file = (input.tool_input?.file_path as string) ?? ""
  if (!isFileEditTool(tool)) return null
  if (!SOURCE_EXT_RE.test(file)) return null
  if (TEST_FILE_RE.test(file)) return null
  return file
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const file = resolveEditTarget(input)
  if (!file) return

  const foundTest = await findSiblingTest(file)
  if (!foundTest) return
  if (!(await isTestFileStale(foundTest))) return

  const message = `Test file exists for this source file: ${foundTest} _ check if it needs updating to reflect your changes.`
  const sessionId = (input.session_id as string) ?? ""
  if (sessionId) await scheduleAutoSteer(sessionId, message, "after_commit")
  await emitContext("PostToolUse", message, input.cwd)
}

if (import.meta.main) void main()
