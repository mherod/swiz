#!/usr/bin/env bun

/**
 * PreToolUse hook: Enforce a configurable cooldown between git pushes.
 * Cooldown is configurable via `swiz settings set push-cooldown-minutes <N>` (default: 1 minute).
 *
 * Reads the last-push timestamp written by posttooluse-push-cooldown.ts.
 * If a push was made within the cooldown window, the hook blocks the new attempt.
 * The sentinel is only written *after* a push executes (PostToolUse), so
 * blocked pushes — rejected by a later PreToolUse hook — do not arm the cooldown.
 *
 * Bypass: force flags (--force, -f, --force-with-lease, --force-if-includes)
 * skip the cooldown. Recommended alternative: `swiz push-wait` which waits
 * for cooldown expiry then pushes automatically.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { getCanonicalPathHash, git } from "../src/git-helpers.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import { readSwizSettings } from "../src/settings.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GIT_PUSH_RE, hasGitPushForceFlag } from "../src/utils/git-utils.ts"
import type { ShellHookInput } from "./schemas.ts"

const DEFAULT_COOLDOWN_MS = 60_000

async function evaluate(input: ShellHookInput) {
  // In standalone mode the matcher isn't applied, so guard on tool name.
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = (input.tool_input?.command as string) ?? ""

  // Only gate on git push commands
  if (!GIT_PUSH_RE.test(command)) return {}

  // Force flags bypass the cooldown
  if (hasGitPushForceFlag(command)) return {}

  // Derive a per-repo sentinel path using shared canonical-path hashing.
  const cwd: string = (input.tool_input?.cwd as string) ?? process.cwd()
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
        return await preToolUseDeny(
          `BLOCKED: git push cooldown active — ${remaining}s remaining.\n\n` +
            `A push was made ${Math.floor(elapsed / 1000)}s ago. ` +
            `Wait ${remaining}s before pushing again.\n\n` +
            `Use \`swiz push-wait origin <branch>\` to automatically wait and push when the cooldown clears.`
        )
      }
    }
  }

  return preToolUseAllow("Push cooldown clear")
}

const pretoolusePushCooldown: SwizShellHook = {
  name: "pretooluse-push-cooldown",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusePushCooldown

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusePushCooldown)
