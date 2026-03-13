#!/usr/bin/env bun
// PreToolUse hook: Block direct edits to dependency blocks in package.json.
// Agents should use the package manager (pnpm add, bun add, etc.) to keep lockfiles in sync.
//
// For Edit tools, computes projected file content (current file + replacement)
// then compares dependency blocks before/after to detect mutations.
// For Write tools, parses the full content directly.

import { isNodeModulesPath } from "../src/node-modules-path.ts"
import {
  denyPreToolUse,
  detectPackageManager,
  isEditTool,
  isFileEditTool,
  isWriteTool,
} from "./hook-utils.ts"

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

async function checkEditTool(
  input: Record<string, unknown>,
  filePath: string,
  addCmd: string
): Promise<void> {
  const toolInput = input.tool_input as Record<string, string> | undefined
  const oldString: string = toolInput?.old_string ?? ""
  const newString: string = toolInput?.new_string ?? ""
  if (!oldString && !newString) process.exit(0)

  let currentContent: string
  try {
    currentContent = await Bun.file(filePath).text()
  } catch {
    process.exit(0)
  }

  const projectedContent = currentContent.replace(oldString, newString)

  let currentParsed: Record<string, unknown>
  try {
    currentParsed = JSON.parse(currentContent)
  } catch {
    process.exit(0)
  }

  let projectedParsed: Record<string, unknown>
  try {
    projectedParsed = JSON.parse(projectedContent)
  } catch {
    process.exit(0)
  }

  if (depsChanged(depsSnapshot(currentParsed), depsSnapshot(projectedParsed))) {
    denyPreToolUse(
      `Do not directly edit dependency blocks in package.json. ` +
        `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
    )
  }
}

async function main() {
  const input = await Bun.stdin.json().catch(() => null)
  if (!input) process.exit(0)

  const toolName: string = input.tool_name ?? ""
  if (!isFileEditTool(toolName)) process.exit(0)

  const filePath: string = input.tool_input?.file_path ?? input.tool_input?.path ?? ""
  if (!filePath.endsWith("package.json") || isNodeModulesPath(filePath)) process.exit(0)

  const PM = await detectPackageManager()
  const ADD_CMD =
    PM === "bun"
      ? "bun add"
      : PM === "pnpm"
        ? "pnpm add"
        : PM === "yarn"
          ? "yarn add"
          : "npm install"

  try {
    if (isWriteTool(toolName)) {
      await checkWriteTool(input, ADD_CMD)
    } else if (isEditTool(toolName)) {
      await checkEditTool(input, filePath, ADD_CMD)
    }
  } catch {}
}

if (import.meta.main) main().catch(() => process.exit(0))
