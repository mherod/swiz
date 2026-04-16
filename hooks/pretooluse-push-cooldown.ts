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
import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { readSwizSettings } from "../src/settings.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GIT_PUSH_RE, hasGitPushForceFlag } from "../src/utils/git-utils.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const DEFAULT_COOLDOWN_MS = 60_000

async function resolveCooldownMs(): Promise<number> {
  const settings = await readSwizSettings()
  const minutes = settings.pushCooldownMinutes ?? 0
  return minutes > 0 ? minutes * 60_000 : DEFAULT_COOLDOWN_MS
}

async function checkCooldown(
  sentinelPath: string,
  cooldownMs: number
): Promise<{ blocked: boolean; message?: string }> {
  const sentinel = Bun.file(sentinelPath)
  if (!(await sentinel.exists())) return { blocked: false }
  const raw = (await sentinel.text()).trim()
  const lastPush = parseInt(raw, 10)
  if (Number.isNaN(lastPush)) return { blocked: false }

  const elapsed = Date.now() - lastPush
  if (elapsed >= cooldownMs) return { blocked: false }

  const remaining = Math.ceil((cooldownMs - elapsed) / 1000)
  return {
    blocked: true,
    message:
      `BLOCKED: git push cooldown active — ${remaining}s remaining.\n\n` +
      `A push was made ${Math.floor(elapsed / 1000)}s ago. ` +
      `Wait ${remaining}s before pushing again.\n\n` +
      `Use \`swiz push-wait origin <branch>\` to automatically wait and push when the cooldown clears.`,
  }
}

async function evaluate(input: ShellHookInput) {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = (input.tool_input?.command as string) ?? ""
  if (!GIT_PUSH_RE.test(command)) return {}
  if (hasGitPushForceFlag(command)) return {}

  const cwd: string = (input.tool_input?.cwd as string) ?? process.cwd()
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  const repoKey = getCanonicalPathHash(repoRoot || cwd)
  const sentinelPath = swizPushCooldownSentinelPath(repoKey)

  const cooldownMs = await resolveCooldownMs()
  const result = await checkCooldown(sentinelPath, cooldownMs)
  if (result.blocked) return preToolUseDeny(result.message!)

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
