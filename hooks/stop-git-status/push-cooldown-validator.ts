/**
 * Push cooldown management.
 *
 * Tracks push prompts to avoid re-blocking on unpushed commits
 * when a push is already in flight.
 */

import { stopGitPushPromptedFlagPath } from "../../src/temp-paths.ts"
import { git, sanitizeSessionId } from "../../src/utils/hook-utils.ts"

const DEFAULT_PUSH_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Get path to push cooldown sentinel file.
 */
function pushSentinelPath(safeSession: string): string {
  return stopGitPushPromptedFlagPath(safeSession)
}

/**
 * Check if push cooldown is active.
 *
 * When user-configured cooldown > 0: only sentinel file is checked
 * (supports in-flight pushes where remote hasn't updated yet).
 *
 * When cooldown === 0 (default): both sentinel AND remote commit time
 * are checked for strictness.
 */
export async function isPushCooldownActive(
  sessionId: string | undefined,
  cwd: string,
  branch: string,
  configuredCooldownMinutes: number
): Promise<boolean> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return false

  const cooldownMs =
    configuredCooldownMinutes > 0 ? configuredCooldownMinutes * 60 * 1000 : DEFAULT_PUSH_COOLDOWN_MS

  const sentinelFile = Bun.file(pushSentinelPath(safeSession))
  if (!(await sentinelFile.exists())) return false

  const sentinelMtime = (await sentinelFile.stat()).mtime.getTime()
  if (Date.now() - sentinelMtime > cooldownMs) return false

  // With user-configured cooldown, sentinel-within-window is sufficient
  if (configuredCooldownMinutes > 0) return true

  // Default: also check remote commit time for strictness
  const rawTime = await git(["log", "-1", "--format=%ct", `origin/${branch}`], cwd)
  const remoteCommitTime = parseInt(rawTime, 10)
  if (Number.isNaN(remoteCommitTime)) return false

  return Date.now() - remoteCommitTime * 1000 < cooldownMs
}

/**
 * Mark that a push prompt was issued in this session.
 * Exported for stop-ship-checklist composition.
 */
export async function markPushPrompted(sessionId: string | undefined): Promise<void> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return
  try {
    await Bun.write(pushSentinelPath(safeSession), "")
  } catch {}
}
