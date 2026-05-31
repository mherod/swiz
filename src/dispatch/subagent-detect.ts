/** A hook payload is a subagent session when Claude Code populates the
 *  subagent-context fields (agent_type / agent_id from AgentHookContextSchema).
 *  Top-level orchestrator sessions leave both absent. */
export function isSubagentSession(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  const agentType = payload.agent_type
  const agentId = payload.agent_id
  return (
    (typeof agentType === "string" && agentType.length > 0) ||
    (typeof agentId === "string" && agentId.length > 0)
  )
}
