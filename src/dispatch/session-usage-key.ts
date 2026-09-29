/**
 * Key for per-session tool usage (#962).
 *
 * Claude Code subagent hook calls carry the parent's `session_id` plus an `agent_id`. Keying
 * usage by session alone folded a subagent's Reads into the parent's streaks, so a delegated
 * search could lock the parent out of Read. Each subagent gets its own usage stream instead.
 */
export function sessionUsageKey(sessionId: string, agentId?: string | null): string {
  return agentId ? `${sessionId}#agent:${agentId}` : sessionId
}

/** True when the key names a subagent's stream rather than the parent session's. */
export function isSubagentUsageKey(key: string): boolean {
  return key.includes("#agent:")
}
