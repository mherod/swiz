#!/usr/bin/env bun

// PreToolUse hook: Enforce a 60-second cooldown between git pushes.
//
// After any git push the last-push timestamp is written to a per-repo file in
// /tmp. If another git push is attempted within 60 seconds, the hook blocks it.
//
// Bypass: force flags (--force, -f, --force-with-lease, --force-if-includes)
// skip the cooldown. Recommended alternative: `swiz push-wait` which waits
// for cooldown expiry then pushes automatically.
// Rationale: prevents accidental rapid-fire pushes that could trigger CI
// loops, burn through rate limits, or push partially-prepared commits.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  denyPreToolUse,
  GIT_PUSH_RE,
  getCanonicalPathHash,
  git,
  hasGitPushForceFlag,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const COOLDOWN_MS = 60_000

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Only gate on git push commands
if (!GIT_PUSH_RE.test(command)) process.exit(0)

// Any force flag bypasses the cooldown. Uses token-based parsing to correctly
// handle -- end-of-flags, git global options, and flags in any operand position.
if (hasGitPushForceFlag(command)) process.exit(0)

// Derive a per-repo sentinel path using shared canonical-path hashing.
// Uses git root when available, falls back to cwd for non-git directories.
const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()
const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
const repoKey = getCanonicalPathHash(repoRoot || cwd)
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
          `Use \`swiz push-wait origin <branch>\` to automatically wait and push when the cooldown clears.`
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
