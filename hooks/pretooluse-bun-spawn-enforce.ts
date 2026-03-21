#!/usr/bin/env bun
// PreToolUse hook: Blocks Node.js sync child_process operations when the target
// file already uses Bun APIs or has a bun shebang. Enforces Bun.spawn()/Bun.$``.

import { allowPreToolUse, computeProjectedContent, denyPreToolUse } from "./utils/hook-utils.ts"

/** Patterns indicating the file uses Bun's native APIs. */
const BUN_API_RE = /\bBun\.(file|write|spawn|serve|listen|sleep|which|escapeHTML|hash)\s*\(/

/** Patterns indicating the file has a bun shebang. */
const BUN_SHEBANG_RE = /^#!.*\bbun\b/m

/**
 * Blocked Node.js sync child_process APIs with their Bun-native replacements.
 * Constructed dynamically to avoid keyword self-detection by this hook.
 */
export const BLOCKED_NODE_SPAWN_OPS: Array<{ re: RegExp; name: string; replacement: string }> = [
  {
    re: new RegExp(["\\b", "exec", "Sync", "\\s*\\("].join("")),
    name: ["exec", "Sync"].join(""),
    replacement: 'Bun.spawn(["sh", "-c", cmd])  or  Bun.$`cmd`',
  },
  {
    re: new RegExp(["\\b", "spawn", "Sync", "\\s*\\("].join("")),
    name: ["spawn", "Sync"].join(""),
    replacement: "Bun.spawn([cmd, ...args])",
  },
  {
    re: new RegExp(["\\b", "exec", "File", "Sync", "\\s*\\("].join("")),
    name: ["exec", "File", "Sync"].join(""),
    replacement: "Bun.spawn([file, ...args])",
  },
]

/**
 * Check whether the projected file content uses Bun APIs or has a bun shebang.
 */
export function usesBunApis(content: string): boolean {
  return BUN_SHEBANG_RE.test(content) || BUN_API_RE.test(content)
}

/**
 * Find all blocked Node.js sync child_process operations in the projected content.
 */
export function findBlockedNodeSpawnOps(
  projected: string
): Array<{ name: string; replacement: string }> {
  return BLOCKED_NODE_SPAWN_OPS.filter((op) => op.re.test(projected)).map((op) => ({
    name: op.name,
    replacement: op.replacement,
  }))
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
    const blocked = findBlockedNodeSpawnOps(projectedContent)
    if (blocked.length > 0) {
      const lines = [
        "This file uses Bun APIs or has a bun shebang but calls Node.js sync child_process APIs.",
        "",
        "Blocked operations and their Bun-native replacements:",
      ]
      for (const op of blocked) {
        lines.push(`  ${op.name}(...)  ->  ${op.replacement}`)
      }
      lines.push("")
      lines.push("Use Bun.spawn() for async subprocess execution or Bun.$`` for shell commands.")
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
