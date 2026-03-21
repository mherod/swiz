#!/usr/bin/env bun

// PreToolUse hook: Enforce a configurable cooldown between git pushes.
// Cooldown is configurable via `swiz settings set push-cooldown-minutes <N>` (default: 1 minute).
//
// Reads the last-push timestamp written by posttooluse-push-cooldown.ts.
// If a push was made within the cooldown window, the hook blocks the new attempt.
// The sentinel is only written *after* a push executes (PostToolUse), so
// blocked pushes — rejected by a later PreToolUse hook — do not arm the
// cooldown.
//
// Bypass: force flags (--force, -f, --force-with-lease, --force-if-includes)
// skip the cooldown. Recommended alternative: `swiz push-wait` which waits
// for cooldown expiry then pushes automatically.
// Rationale: prevents accidental rapid-fire pushes that could trigger CI
// loops, burn through rate limits, or push partially-prepared commits.

import { readSwizSettings } from "../src/settings.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  GIT_PUSH_RE,
  getCanonicalPathHash,
  git,
  hasGitPushForceFlag,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const DEFAULT_COOLDOWN_MS = 60_000

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
const sentinelPath = swizPushCooldownSentinelPath(repoKey)

// Resolve cooldown from settings (pushCooldownMinutes → ms)
const settings = await readSwizSettings()
const cooldownMs =
  (settings.pushCooldownMinutes ?? 0) > 0
    ? settings.pushCooldownMinutes * 60_000
    : DEFAULT_COOLDOWN_MS

// Read last push time
const now = Date.now()
if (await Bun.file(sentinelPath).exists()) {
  const raw = (await Bun.file(sentinelPath).text()).trim()
  const lastPush = parseInt(raw, 10)
  if (!Number.isNaN(lastPush)) {
    const elapsed = now - lastPush
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000)
      denyPreToolUse(
        `BLOCKED: git push cooldown active — ${remaining}s remaining.\n\n` +
          `A push was made ${Math.floor(elapsed / 1000)}s ago. ` +
          `Wait ${remaining}s before pushing again.\n\n` +
          `Use \`swiz push-wait origin <branch>\` to automatically wait and push when the cooldown clears.`
      )
    }
  }
}

// Sentinel is written by posttooluse-push-cooldown.ts after the push executes,
// so only successful (non-blocked) pushes arm the cooldown.
allowPreToolUse("Push cooldown clear")
