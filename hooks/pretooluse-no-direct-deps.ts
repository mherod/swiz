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

const pretoolUseNoDirectDeps: SwizToolHook = {
  name: "pretooluse-no-direct-deps",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolName: string = (input.tool_name as string) ?? ""
    if (!isFileEditTool(toolName)) return preToolUseAllow("")

    const toolInput = input.tool_input as Record<string, string> | undefined
    const filePath: string = toolInput?.file_path ?? toolInput?.path ?? ""
    if (!filePath.endsWith("package.json") || isNodeModulesPath(filePath))
      return preToolUseAllow("")

    const PM = await detectPackageManager(dirname(filePath))
    const addCmd = ADD_COMMANDS[PM ?? ""] ?? "npm install"

    try {
      if (isWriteTool(toolName)) {
        const content: string = toolInput?.content ?? ""
        if (!content) return preToolUseAllow("")
        const parsed = parseContentSafely(content)
        if (!parsed) return preToolUseAllow("")
        if (hasDependencyBlocks(parsed)) {
          return await preToolUseDeny(
            `Do not directly write dependency blocks in package.json. ` +
              `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
          )
        }
      } else if (isEditTool(toolName)) {
        const projectedContent = await computeProjectedContent(toolName, filePath, toolInput ?? {})
        if (projectedContent === null) return preToolUseAllow("")

        let currentContent: string
        try {
          currentContent = await Bun.file(filePath).text()
        } catch {
          return preToolUseAllow("")
        }

        const currentParsed = parseContentSafely(currentContent)
        const projectedParsed = parseContentSafely(projectedContent)
        if (!currentParsed || !projectedParsed) return preToolUseAllow("")

        if (depsChanged(depsSnapshot(currentParsed), depsSnapshot(projectedParsed))) {
          return await preToolUseDeny(
            `Do not directly edit dependency blocks in package.json. ` +
              `Use the package manager (\`${addCmd}\`) instead to keep the lockfile in sync.`
          )
        }
      }
    } catch {
      return preToolUseAllow("")
    }

    return preToolUseAllow(`No direct dependency edits detected in ${filePath.split("/").pop()}`)
  },
}

export default pretoolUseNoDirectDeps

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseNoDirectDeps)
