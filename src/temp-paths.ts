/**
 * Shared /tmp path builders for sentinel, lock, and log files.
 * Keep all filenames centralized so hooks/commands stay consistent.
 */

export const TMP_ROOT = "/tmp"

/** Incoming dispatch payload dumps (on by default; disable with `SWIZ_CAPTURE_INCOMING=0`). See `incoming-capture.ts`. */
export const SWIZ_INCOMING_ROOT = `${TMP_ROOT}/swiz-incoming`

export function swizDispatchLogPath(): string {
  return `${TMP_ROOT}/swiz-dispatch.log`
}

export function swizHookCooldownPath(key: string): string {
  return `${TMP_ROOT}/swiz-hook-cooldown-${key}.timestamp`
}

export function swizPushCooldownSentinelPath(repoKey: string): string {
  return `${TMP_ROOT}/swiz-push-cooldown-${repoKey}.timestamp`
}

export function taskListSyncSentinelPath(sessionId: string): string {
  return `${TMP_ROOT}/swiz-tasklist-sync-${sessionId}.timestamp`
}

export function stopGitPushPromptedFlagPath(safeSession: string): string {
  return `${TMP_ROOT}/stop-git-push-prompted-${safeSession}.flag`
}

export function stopLockfileDriftBlockedFlagPath(sessionId: string): string {
  return `${TMP_ROOT}/stop-lockfile-drift-blocked-${sessionId}.flag`
}

export function stopPersonalRepoIssuesCooldownPath(key: string): string {
  return `${TMP_ROOT}/stop-personal-repo-issues-${key}.cooldown`
}

export function speakLockPath(sessionId: string): string {
  return `${TMP_ROOT}/speak-lock-${sessionId}.lock`
}

export function speakPositionPath(sessionId: string): string {
  return `${TMP_ROOT}/speak-pos-${sessionId}.txt`
}

export function speakCooldownPath(sessionId: string): string {
  return `${TMP_ROOT}/speak-cooldown-${sessionId}.timestamp`
}

export function sessionTaskSentinelPath(safeSentinel: string, safeSession: string): string {
  return `${TMP_ROOT}/${safeSentinel}-${safeSession}.flag`
}

export function claudeTaskOutputPath(uid: number, cwdKey: string, taskId: string): string {
  return `${TMP_ROOT}/claude-${uid}/${cwdKey}/tasks/${taskId}.output`
}

export function swizPushResultPath(repoKey: string): string {
  return `${TMP_ROOT}/swiz-push-result-${repoKey}.json`
}

export function swizEmergencyBypassPath(repoKey: string): string {
  return `${TMP_ROOT}/swiz-emergency-bypass-${repoKey}.json`
}

export function swizPseudoHookLogPath(): string {
  return `${TMP_ROOT}/swiz-pseudohooks.log`
}

export function stopAutoContSuggestionsPath(safeSession: string): string {
  return `${TMP_ROOT}/swiz-stop-suggestions-${safeSession}.json`
}

/**
 * Heartbeat sentinel refreshed by the `swiz mcp` drain loop while a channel
 * consumer is connected for a given project. PostToolUse auto-steer checks
 * the mtime to decide whether MCP is live for this project and should be
 * allowed to drain `next_turn` requests instead of the AppleScript path.
 */
export function swizMcpChannelHeartbeatPath(projectKey: string): string {
  return `${TMP_ROOT}/swiz-mcp-channel-${projectKey}.heartbeat`
}

/** MCP heartbeat freshness window. Must exceed the drain interval plus a margin. */
export const SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS = 5_000

/**
 * Notify sentinel touched by auto-steer producers to wake the MCP drain loop.
 * The loop watches this path with `fs.watch`; any mtime bump triggers an
 * immediate drain instead of waiting for the next poll tick.
 */
export function swizMcpChannelNotifyPath(projectKey: string): string {
  return `${TMP_ROOT}/swiz-mcp-channel-${projectKey}.notify`
}

/**
 * JSONL sink for messages sent back by the Claude session through the swiz
 * MCP `reply` tool. Producers append one JSON line per reply; consumers tail
 * the file. Kept in ~/.swiz so replies survive /tmp cleanup on reboot.
 */
export function swizMcpRepliesLogPath(home: string): string {
  return `${home}/.swiz/mcp-replies.jsonl`
}

/**
 * Cached PR baseline for mid-session drift detection.
 * Written on first check per session; compared on subsequent checks.
 */
export function midSessionPrBaselinePath(safeSession: string): string {
  return `${TMP_ROOT}/swiz-mid-session-pr-baseline-${safeSession}.json`
}

/**
 * Sentinel touched when a ceremony skill (e.g. /end-of-day) completes for a
 * given date. The stop hook reads the mtime to decide whether the ceremony has
 * run today before blocking the session.
 *
 * @param skill - short skill name, e.g. "end-of-day"
 * @param date  - ISO date string, e.g. "2026-05-03"
 */
export function swizCeremonyDayFlagPath(skill: string, date: string): string {
  return `${TMP_ROOT}/swiz-ceremony-${skill}-${date}.flag`
}
