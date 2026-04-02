import type { AgentDef } from "../../agents.ts"

export function extractOldHooks(
  existing: Record<string, any>,
  agent: AgentDef
): Record<string, any> {
  const raw = agent.wrapsHooks
    ? (((existing as Record<string, any>).hooks as Record<string, any>) ?? {})
    : ((existing[agent.hooksKey] as Record<string, any>) ?? {})
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

export function buildProposedAgentSettings(
  existing: Record<string, any>,
  agent: AgentDef,
  config: Record<string, unknown[]>
): string {
  const proposed = agent.wrapsHooks
    ? { ...agent.wrapsHooks, hooks: config }
    : { ...existing, [agent.hooksKey]: config }
  return JSON.stringify(proposed, null, 2)
}
