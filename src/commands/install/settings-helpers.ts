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
  config: Record<string, unknown[]>,
  options: { replaceAllHookEntries?: boolean } = {}
): string {
  let proposed: Record<string, unknown>
  if (agent.wrapsHooks) {
    proposed = { ...agent.wrapsHooks, hooks: config }
  } else if (options.replaceAllHookEntries && agent.configStyle === "flat-lifecycle") {
    // Antigravity's hooks.json is a map of named hook groups. In aggressive
    // mode, discard every group except swiz rather than preserving siblings.
    proposed = { [agent.hooksKey]: config }
  } else {
    proposed = { ...existing, [agent.hooksKey]: config }
  }
  return JSON.stringify(proposed, null, 2)
}
