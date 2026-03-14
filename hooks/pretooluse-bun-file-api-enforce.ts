#!/usr/bin/env bun
// PreToolUse hook: Blocks Node.js sync file operations when the target file
// already uses Bun APIs or has a bun shebang. Enforces Bun.file()/Bun.write().

import { allowPreToolUse, denyPreToolUse } from "./hook-utils.ts"

/** Patterns indicating the file uses Bun's native APIs. */
const BUN_API_RE = /\bBun\.(file|write|spawn|serve|listen|sleep|which|escapeHTML|hash)\s*\(/

/** Patterns indicating the file has a bun shebang. */
const BUN_SHEBANG_RE = /^#!.*\bbun\b/m

/**
 * Blocked Node.js sync file APIs with their Bun-native replacements.
 * Constructed dynamically to avoid keyword self-detection by this hook.
 */
const BLOCKED_NODE_FILE_OPS: Array<{ re: RegExp; name: string; replacement: string }> = [
  {
    re: new RegExp(["\\b", "read", "File", "Sync", "\\s*\\("].join("")),
    name: ["read", "File", "Sync"].join(""),
    replacement: "await Bun.file(path).text()  or  await Bun.file(path).json()",
  },
  {
    re: new RegExp(["\\b", "write", "File", "Sync", "\\s*\\("].join("")),
    name: ["write", "File", "Sync"].join(""),
    replacement: "await Bun.write(path, data)",
  },
  {
    re: new RegExp(["\\b", "append", "File", "Sync", "\\s*\\("].join("")),
    name: ["append", "File", "Sync"].join(""),
    replacement: "await Bun.write(path, existingContent + newData)  (read first with Bun.file)",
  },
  {
    re: new RegExp(["\\b", "unlink", "Sync", "\\s*\\("].join("")),
    name: ["unlink", "Sync"].join(""),
    replacement: "await Bun.file(path).delete()  or  await unlink(path) from node:fs/promises",
  },
  {
    re: new RegExp(["\\b", "rm", "Sync", "\\s*\\("].join("")),
    name: ["rm", "Sync"].join(""),
    replacement: "await Bun.file(path).delete()  or  await rm(path) from node:fs/promises",
  },
]

/**
 * Check whether the projected file content uses Bun APIs or has a bun shebang.
 */
export function usesBunApis(content: string): boolean {
  return BUN_SHEBANG_RE.test(content) || BUN_API_RE.test(content)
}

/**
 * Find all blocked Node.js sync file operations in the projected content.
 */
export function findBlockedNodeFileOps(
  projected: string
): Array<{ name: string; replacement: string }> {
  return BLOCKED_NODE_FILE_OPS.filter((op) => op.re.test(projected)).map((op) => ({
    name: op.name,
    replacement: op.replacement,
  }))
}

async function computeProjectedContent(
  toolName: string,
  filePath: string,
  toolInput: Record<string, unknown>
): Promise<string | null> {
  if (toolName === "Write" || toolName === "NotebookEdit") {
    return ((toolInput.content as string) ?? "") || null
  }
  if (toolName === "Edit") {
    const oldString = (toolInput.old_string as string) ?? ""
    const newString = (toolInput.new_string as string) ?? ""
    if (!oldString && !newString) return null

    let currentContent: string
    try {
      currentContent = await Bun.file(filePath).text()
    } catch {
      return null
    }
    return currentContent.replace(oldString, newString)
  }
  return null
}

function parseInput(input: Record<string, unknown>): {
  toolName: string
  filePath: string
  toolInput: Record<string, unknown>
} | null {
  const toolName: string = (input.tool_name as string) ?? ""
  const ti = (input.tool_input ?? {}) as Record<string, unknown>
  const filePath: string = (ti.file_path as string) ?? (ti.path as string) ?? ""
  if (!filePath || !/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) return null
  return { toolName, filePath, toolInput: ti }
}

async function main() {
  const raw = await Bun.stdin.json().catch(() => null)
  if (!raw) process.exit(0)

  const parsed = parseInput(raw as Record<string, unknown>)
  if (!parsed) process.exit(0)

  const projectedContent = await computeProjectedContent(
    parsed.toolName,
    parsed.filePath,
    parsed.toolInput
  )
  if (!projectedContent) process.exit(0)

  if (usesBunApis(projectedContent)) {
    const blocked = findBlockedNodeFileOps(projectedContent)
    if (blocked.length > 0) {
      const lines = [
        "This file uses Bun APIs or has a bun shebang but calls Node.js sync file APIs.",
        "",
        "Blocked operations and their Bun-native replacements:",
      ]
      for (const op of blocked) {
        lines.push(`  ${op.name}(...)  ->  ${op.replacement}`)
      }
      lines.push("")
      lines.push("Directory operations (mkdir, readdir, stat) are allowed via node:fs/promises.")
      denyPreToolUse(lines.join("\n"))
    }
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
