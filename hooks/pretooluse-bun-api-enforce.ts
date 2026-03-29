#!/usr/bin/env bun
// PreToolUse hook: Blocks Node.js sync file and child_process operations when
// the target file already uses Bun APIs or has a bun shebang.
// Enforces Bun.file()/Bun.write()/Bun.spawn()/Bun.$``.

import { parseBunEnforcementInput, usesBunApis } from "../src/utils/bun-enforcement-utils.ts"
import {
  allowPreToolUse,
  computeProjectedContent,
  denyPreToolUse,
} from "../src/utils/hook-utils.ts"

// ── Blocked operations ──────────────────────────────────────────────────────

/**
 * Blocked Node.js sync file APIs with their Bun-native replacements.
 * Constructed dynamically to avoid keyword self-detection by this hook.
 */
export const BLOCKED_NODE_FILE_OPS: Array<{ re: RegExp; name: string; replacement: string }> = [
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

const ALL_BLOCKED_OPS = [...BLOCKED_NODE_FILE_OPS, ...BLOCKED_NODE_SPAWN_OPS]

export { usesBunApis } from "../src/utils/bun-enforcement-utils.ts"

/** Find all blocked Node.js sync file operations in projected content. */
export function findBlockedNodeFileOps(
  projected: string
): Array<{ name: string; replacement: string }> {
  return BLOCKED_NODE_FILE_OPS.filter((op) => op.re.test(projected)).map((op) => ({
    name: op.name,
    replacement: op.replacement,
  }))
}

/** Find all blocked Node.js sync child_process operations in projected content. */
export function findBlockedNodeSpawnOps(
  projected: string
): Array<{ name: string; replacement: string }> {
  return BLOCKED_NODE_SPAWN_OPS.filter((op) => op.re.test(projected)).map((op) => ({
    name: op.name,
    replacement: op.replacement,
  }))
}

// ── Main ────────────────────────────────────────────────────────────────────

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
    const blocked = ALL_BLOCKED_OPS.filter((op) => op.re.test(projectedContent)).map((op) => ({
      name: op.name,
      replacement: op.replacement,
    }))
    if (blocked.length > 0) {
      const lines = [
        "This file uses Bun APIs or has a bun shebang but calls Node.js sync APIs.",
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
