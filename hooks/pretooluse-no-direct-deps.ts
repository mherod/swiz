#!/usr/bin/env bun
// PreToolUse hook: Block direct edits to dependency blocks in package.json.
// Agents should use the package manager (pnpm add, bun add, etc.) to keep lockfiles in sync.
//
// For Edit tools, computes projected file content (current file + replacement)
// then compares dependency blocks before/after to detect mutations.
// For Write tools, parses the full content directly.
//
// Dual-mode: exports a SwizToolHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { dirname } from "node:path"
import { isNodeModulesPath } from "../src/node-modules-path.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { isEditTool, isFileEditTool, isWriteTool } from "../src/tool-matchers.ts"
import { computeProjectedContent } from "../src/utils/edit-projection.ts"
import { detectPackageManager } from "../src/utils/package-detection.ts"

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

function depsSnapshot(parsed: Record<string, any>): Record<string, Record<string, string>> {
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

function hasDependencyBlocks(parsed: Record<string, any>): boolean {
  return DEP_FIELDS.some(
    (f) => parsed[f] && typeof parsed[f] === "object" && Object.keys(parsed[f] as object).length > 0
  )
}

function parseContentSafely(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

const ADD_COMMANDS: Record<string, string> = {
  bun: "bun add",
  pnpm: "pnpm add",
  yarn: "yarn add",
  npm: "npm install",
}

function checkWriteMutation(content: string, addCmd: string) {
  if (!content) return null
  const parsed = parseContentSafely(content)
  if (parsed && hasDependencyBlocks(parsed)) {
    return preToolUseDeny(
      `Do not directly write dependency blocks in package.json. ` +
        `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
    )
  }
  return null
}

async function checkEditMutation(
  toolName: string,
  filePath: string,
  toolInput: Record<string, string>,
  addCmd: string
) {
  const projectedContent = await computeProjectedContent(toolName, filePath, toolInput)
  if (projectedContent === null) return null

  let currentContent: string
  try {
    currentContent = await Bun.file(filePath).text()
  } catch {
    return null
  }

  const currentParsed = parseContentSafely(currentContent)
  const projectedParsed = parseContentSafely(projectedContent)
  if (!currentParsed || !projectedParsed) return null

  if (depsChanged(depsSnapshot(currentParsed), depsSnapshot(projectedParsed))) {
    return preToolUseDeny(
      `Do not directly edit dependency blocks in package.json. ` +
        `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
    )
  }
  return null
}

function extractToolInput(rawInput: Record<string, any>) {
  const toolName = (rawInput.tool_name as string) || ""
  const toolInput = (rawInput.tool_input as Record<string, string>) || {}
  const content = toolInput.content || ""
  const filePath = toolInput.file_path || toolInput.path || ""
  return { toolName, toolInput, filePath, content }
}

function shouldSkipHook(toolName: string, filePath: string): boolean {
  if (!isFileEditTool(toolName)) return true
  if (!filePath.endsWith("package.json")) return true
  if (isNodeModulesPath(filePath)) return true
  return false
}

const pretoolUseNoDirectDeps: SwizToolHook = {
  name: "pretooluse-no-direct-deps",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(rawInput) {
    const { toolName, toolInput, filePath, content } = extractToolInput(
      rawInput as Record<string, any>
    )

    if (shouldSkipHook(toolName, filePath)) {
      return preToolUseAllow("")
    }

    const PM = await detectPackageManager(dirname(filePath))
    const addCmd = ADD_COMMANDS[PM || "npm"] || "npm install"

    try {
      const result = isWriteTool(toolName)
        ? checkWriteMutation(content, addCmd)
        : isEditTool(toolName)
          ? await checkEditMutation(toolName, filePath, toolInput, addCmd)
          : null

      if (result) return result
    } catch {
      return preToolUseAllow("")
    }

    return preToolUseAllow(`No direct dependency edits detected in package.json`)
  },
}

export default pretoolUseNoDirectDeps

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseNoDirectDeps)
