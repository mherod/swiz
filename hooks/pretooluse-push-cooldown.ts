#!/usr/bin/env bun

// PreToolUse hook: Enforce a 60-second cooldown between git pushes.
//
// After any git push the last-push timestamp is written to a per-repo file in
// /tmp. If another git push is attempted within 60 seconds, the hook blocks it.
//
// Bypass: include --force or -f in the push command to skip the cooldown.
// Rationale: prevents accidental rapid-fire pushes that could trigger CI
// loops, burn through rate limits, or push partially-prepared commits.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { denyPreToolUse, GIT_PUSH_RE, git, isShellTool, type ToolHookInput } from "./hook-utils.ts"

const COOLDOWN_MS = 60_000

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Only gate on git push commands
if (!GIT_PUSH_RE.test(command)) process.exit(0)

// --force or -f bypasses the cooldown
if (
  /\bgit\s+push\b.*(?:--force|-f)\b/.test(command) ||
  /\bgit\s+push\b.*-[a-zA-Z]*f/.test(command)
) {
  process.exit(0)
}

// Derive a per-repo sentinel path keyed on the git root (or cwd as fallback)
const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()
const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
const repoKey = createHash("sha1")
  .update(repoRoot || cwd)
  .digest("hex")
  .slice(0, 12)
const sentinelPath = `/tmp/swiz-push-cooldown-${repoKey}.timestamp`

// Read last push time
const now = Date.now()
if (existsSync(sentinelPath)) {
  const raw = readFileSync(sentinelPath, "utf8").trim()
  const lastPush = parseInt(raw, 10)
  if (!isNaN(lastPush)) {
    const elapsed = now - lastPush
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000)
      denyPreToolUse(
        `BLOCKED: git push cooldown active — ${remaining}s remaining.\n\n` +
          `A push was made ${Math.floor(elapsed / 1000)}s ago. ` +
          `Wait ${remaining}s before pushing again.\n\n` +
          `To bypass the cooldown, add --force to your push command:\n` +
          `  git push --force origin <branch>`
      )
    }
  }
}

// Record this push attempt timestamp
try {
  writeFileSync(sentinelPath, String(now))
} catch {
  // Non-fatal: if we can't write the sentinel, allow the push
}
