#!/usr/bin/env bun
// PreToolUse hook: Block direct edits to dependency blocks in package.json.
// Agents should use the package manager (pnpm add, bun add, etc.) to keep lockfiles in sync.
//
// For Edit tools, computes projected file content (current file + replacement)
// then compares dependency blocks before/after to detect mutations.
// For Write tools, parses the full content directly.

import { dirname } from "node:path"
import { isNodeModulesPath } from "../src/node-modules-path.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  detectPackageManager,
  isEditTool,
  isFileEditTool,
  isWriteTool,
} from "../src/utils/hook-utils.ts"

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

function depsSnapshot(parsed: Record<string, unknown>): Record<string, Record<string, string>> {
  const snap: Record<string, Record<string, string>> = {}
  for (const field of DEP_FIELDS) {
    const block = parsed[field]
    if (block && typeof block === "object" && !Array.isArray(block)) {
      snap[field] = { ...(block as Record<string, string>) }
    }
  }
  return snap
}

function depsChanged(
  before: Record<string, Record<string, string>>,
  after: Record<string, Record<string, string>>
): boolean {
  for (const field of DEP_FIELDS) {
    const a = before[field]
    const b = after[field]
    if (!a && !b) continue
    if (!a || !b) return true
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return true
    for (const key of bKeys) {
      if (a[key] !== b[key]) return true
    }
  }
  return false
}

function hasDependencyBlocks(parsed: Record<string, unknown>): boolean {
  return DEP_FIELDS.some(
    (f) => parsed[f] && typeof parsed[f] === "object" && Object.keys(parsed[f] as object).length > 0
  )
}

async function checkWriteTool(input: Record<string, unknown>, addCmd: string): Promise<void> {
  const toolInput = input.tool_input as Record<string, string> | undefined
  const content: string = toolInput?.content ?? ""
  if (!content) process.exit(0)
  const parsed = JSON.parse(content)
  if (hasDependencyBlocks(parsed)) {
    denyPreToolUse(
      `Do not directly write dependency blocks in package.json. ` +
        `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
    )
  }
}

async function parseContentSafely(content: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

function resolveEditStrings(input: Record<string, unknown>): {
  oldString: string
  newString: string
} | null {
  const toolInput = input.tool_input as Record<string, string> | undefined
  const oldString: string = toolInput?.old_string ?? ""
  const newString: string = toolInput?.new_string ?? ""
  return oldString || newString ? { oldString, newString } : null
}

async function checkEditTool(
  input: Record<string, unknown>,
  filePath: string,
  addCmd: string
): Promise<void> {
  const strings = resolveEditStrings(input)
  if (!strings) process.exit(0)

  let currentContent: string
  try {
    currentContent = await Bun.file(filePath).text()
  } catch {
    process.exit(0)
  }

  const projectedContent = currentContent.replace(strings.oldString, strings.newString)
  const currentParsed = await parseContentSafely(currentContent)
  const projectedParsed = await parseContentSafely(projectedContent)
  if (!currentParsed || !projectedParsed) process.exit(0)

  if (depsChanged(depsSnapshot(currentParsed), depsSnapshot(projectedParsed))) {
    denyPreToolUse(
      `Do not directly edit dependency blocks in package.json. ` +
        `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
    )
  }
}

const ADD_COMMANDS: Record<string, string> = {
  bun: "bun add",
  pnpm: "pnpm add",
  yarn: "yarn add",
  npm: "npm install",
}

function resolveFilePath(input: Record<string, unknown>): string {
  const toolInput = input.tool_input as Record<string, string> | undefined
  return toolInput?.file_path ?? toolInput?.path ?? ""
}

async function validateInputs(
  input: Record<string, unknown>
): Promise<{ filePath: string; toolName: string } | null> {
  const toolName: string = (input.tool_name as string) ?? ""
  if (!isFileEditTool(toolName)) return null

  const filePath = resolveFilePath(input)
  if (!filePath.endsWith("package.json") || isNodeModulesPath(filePath)) return null

  return { filePath, toolName }
}

async function main() {
  const input = await Bun.stdin.json().catch(() => null)
  if (!input) process.exit(0)

  const validation = await validateInputs(input)
  if (!validation) process.exit(0)

  const { filePath, toolName } = validation
  const PM = await detectPackageManager(dirname(filePath))
  const addCmd = ADD_COMMANDS[PM ?? ""] ?? "npm install"

  try {
    if (isWriteTool(toolName)) {
      await checkWriteTool(input, addCmd)
    } else if (isEditTool(toolName)) {
      await checkEditTool(input, filePath, addCmd)
    }
  } catch {}
  allowPreToolUse(`No direct dependency edits detected in ${filePath.split("/").pop()}`)
}

if (import.meta.main) main().catch(() => process.exit(0))
