#!/usr/bin/env bun
// PreToolUse hook: Blocks Node.js sync child_process operations when the target
// file already uses Bun APIs or has a bun shebang. Enforces Bun.spawn()/Bun.$``.

import { parseBunEnforcementInput, usesBunApis } from "./utils/bun-enforcement-utils.ts"
import { allowPreToolUse, computeProjectedContent, denyPreToolUse } from "./utils/hook-utils.ts"

/**
 * Blocked Node.js sync child_process APIs with their Bun-native replacements.
 * Constructed dynamically to avoid keyword self-detection by this hook.
 */
export const BLOCKED_NODE_SPAWN_OPS: Array<{ re: RegExp; name: string; replacement: string }> = [
  {
    re: new RegExp(["(?<!Bun\\.)", "\\b", "exec", "Sync", "\\s*\\("].join("")),
    name: ["exec", "Sync"].join(""),
    replacement: 'Bun.spawn(["sh", "-c", cmd])  or  Bun.$`cmd`',
  },
  {
    re: new RegExp(["(?<!Bun\\.)", "\\b", "spawn", "Sync", "\\s*\\("].join("")),
    name: ["spawn", "Sync"].join(""),
    replacement: "Bun.spawn([cmd, ...args])",
  },
  {
    re: new RegExp(["(?<!Bun\\.)", "\\b", "exec", "File", "Sync", "\\s*\\("].join("")),
    name: ["exec", "File", "Sync"].join(""),
    replacement: "Bun.spawn([file, ...args])",
  },
]

export { usesBunApis } from "./utils/bun-enforcement-utils.ts"

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

async function main() {
  const raw = await Bun.stdin.json().catch(() => null)
  if (!raw) process.exit(0)

  const parsed = parseBunEnforcementInput(raw as Record<string, unknown>)
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
