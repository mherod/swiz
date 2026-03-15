#!/usr/bin/env bun
// Validates lefthook.yml: ensures all referenced local scripts exist on disk.
// Run: bun scripts/validate-lefthook-config.ts

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const ROOT = dirname(dirname(Bun.main))
const CONFIG_PATH = join(ROOT, "lefthook.yml")

if (!existsSync(CONFIG_PATH)) {
  console.error("lefthook.yml not found")
  process.exit(1)
}

// Parse YAML — use the project's yaml dependency
const { parse } = await import("yaml")
const config = parse(await Bun.file(CONFIG_PATH).text()) as Record<string, unknown>

// Extract `run` values from all hook groups → commands
function extractRunCommands(
  obj: Record<string, unknown>
): { hook: string; name: string; run: string }[] {
  const results: { hook: string; name: string; run: string }[] = []
  for (const [hookName, hookValue] of Object.entries(obj)) {
    if (!hookValue || typeof hookValue !== "object") continue
    const hookObj = hookValue as Record<string, unknown>
    const commands = hookObj.commands as Record<string, Record<string, unknown>> | undefined
    if (!commands) continue
    for (const [cmdName, cmdValue] of Object.entries(commands)) {
      if (cmdValue?.run && typeof cmdValue.run === "string") {
        results.push({ hook: hookName, name: cmdName, run: cmdValue.run })
      }
    }
  }
  return results
}

// Extract local file paths from a run command.
// Matches patterns like `bun scripts/foo.ts` or `bun hooks/bar.ts`.
// Skips global commands (bunx, tsc, swiz, timeout, command, etc.)
const LOCAL_SCRIPT_RE = /\bbun\s+(scripts\/\S+|hooks\/\S+)/g

function extractLocalPaths(run: string): string[] {
  const paths: string[] = []
  for (const match of run.matchAll(LOCAL_SCRIPT_RE)) {
    if (match[1]) paths.push(match[1])
  }
  return paths
}

const commands = extractRunCommands(config)
const errors: string[] = []

for (const cmd of commands) {
  const localPaths = extractLocalPaths(cmd.run)
  for (const relPath of localPaths) {
    const absPath = resolve(ROOT, relPath)
    if (!existsSync(absPath)) {
      errors.push(`${cmd.hook} → ${cmd.name}: script not found: ${relPath}`)
    }
  }
}

if (errors.length > 0) {
  console.error("lefthook config validation failed:\n")
  for (const err of errors) {
    console.error(`  ✗ ${err}`)
  }
  process.exit(1)
}

console.error(`✓ lefthook config valid (${commands.length} commands checked)`)
