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

export function sessionTaskSentinelPath(safeSentinel: string, safeSession: string): string {
  return `${TMP_ROOT}/${safeSentinel}-${safeSession}.flag`
}

export function claudeTaskOutputPath(uid: number, cwdKey: string, taskId: string): string {
  return `${TMP_ROOT}/claude-${uid}/${cwdKey}/tasks/${taskId}.output`
}

export function swizPushResultPath(repoKey: string): string {
  return `${TMP_ROOT}/swiz-push-result-${repoKey}.json`
}

export function swizPrPollLogPath(): string {
  return `${TMP_ROOT}/swiz-prpoll.log`
}

export function swizPrPollErrorLogPath(): string {
  return `${TMP_ROOT}/swiz-prpoll-error.log`
}

export function swizEmergencyBypassPath(repoKey: string): string {
  return `${TMP_ROOT}/swiz-emergency-bypass-${repoKey}.json`
}

export function stopAutoContSuggestionsPath(safeSession: string): string {
  return `${TMP_ROOT}/swiz-stop-suggestions-${safeSession}.json`
}
