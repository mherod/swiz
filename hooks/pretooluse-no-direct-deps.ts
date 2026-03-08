#!/usr/bin/env bun
// PreToolUse hook: Block direct edits to dependency blocks in package.json.
// Agents should use the package manager (pnpm add, bun add, etc.) to keep lockfiles in sync.

import { isNodeModulesPath } from "../src/node-modules-path.ts"
import { denyPreToolUse, isFileEditTool } from "./hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName = input.tool_name ?? ""
if (!isFileEditTool(toolName)) process.exit(0)

const filePath: string = input.tool_input?.file_path ?? input.tool_input?.path ?? ""
if (!filePath.endsWith("package.json") || isNodeModulesPath(filePath)) process.exit(0)

const content: string = input.tool_input?.new_string ?? input.tool_input?.content ?? ""
if (!content) process.exit(0)

try {
  const parsed = JSON.parse(content)
  if (parsed.dependencies || parsed.devDependencies || parsed.peerDependencies) {
    denyPreToolUse(
      "Do not directly edit dependency blocks in package.json. " +
        "Use the package manager (pnpm add, bun add, npm install) instead to keep the lockfile in sync."
    )
  }
} catch {
  // Not valid JSON or not a dependency edit — allow
}
