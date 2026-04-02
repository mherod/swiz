import { type AgentDef, translateEvent } from "../../agents.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../../manifest.ts"
import { isManagedSwizCommand } from "../../swiz-hook-commands.ts"

/**
 * Strip swiz-managed and legacy hooks from a nested matcher group array,
 * returning only user-defined entries.
 */
export function stripManagedFromNestedGroups(groups: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const group of groups) {
    const g = group as Record<string, any>
    if (Array.isArray(g.hooks)) {
      const userHooks = g.hooks.filter(
        (h) => !isManagedSwizCommand((h as Record<string, any>).command)
      )
      if (userHooks.length > 0) {
        kept.push({ ...g, hooks: userHooks })
      }
    } else if (!isManagedSwizCommand(g.command)) {
      kept.push(group)
    }
  }
  return kept
}

/**
 * Strip swiz-managed and legacy hooks from a flat hook array.
 */
export function stripManagedFromFlatList(entries: unknown[]): unknown[] {
  return entries.filter((e) => !isManagedSwizCommand((e as Record<string, any>).command))
}

export function supportsAgentEvent(agent: AgentDef, canonicalEvent: string): boolean {
  const unsupported = new Set(agent.unsupportedEvents ?? [])
  return !unsupported.has(canonicalEvent) && canonicalEvent in agent.eventMap
}

export function buildDispatchEntry(
  agent: AgentDef,
  canonicalEvent: string
): { eventName: string; timeout: number; cmd: string } {
  const timeoutScale = agent.id === "gemini" ? 1000 : 1
  const timeout = (DISPATCH_TIMEOUTS[canonicalEvent] ?? 30) * timeoutScale
  const eventName = translateEvent(canonicalEvent, agent)
  const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${canonicalEvent} ${eventName}`
  return { eventName, timeout, cmd }
}

export function addAdditionalDispatchEntries(
  agent: AgentDef,
  merged: Record<string, unknown[]>,
  wrapEntry: (cmd: string, timeout: number) => unknown,
  seenEvents: Set<string>
): void {
  if (!agent.additionalDispatchEntries) return
  for (const [agentEventName, canonicalEvent] of Object.entries(agent.additionalDispatchEntries)) {
    if (!seenEvents.has(canonicalEvent)) continue
    const timeout = DISPATCH_TIMEOUTS[canonicalEvent] ?? 30
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${canonicalEvent} ${agentEventName}`
    if (!merged[agentEventName]) merged[agentEventName] = []
    merged[agentEventName]!.push(wrapEntry(cmd, timeout))
  }
}

export function addDispatchEntries(
  agent: AgentDef,
  merged: Record<string, unknown[]>,
  wrapEntry: (cmd: string, timeout: number) => unknown
): void {
  const seenEvents = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled || seenEvents.has(group.event)) continue
    seenEvents.add(group.event)
    if (!supportsAgentEvent(agent, group.event)) continue
    const { eventName, timeout, cmd } = buildDispatchEntry(agent, group.event)
    if (!merged[eventName]) merged[eventName] = []
    merged[eventName]!.push(wrapEntry(cmd, timeout))
  }

  addAdditionalDispatchEntries(agent, merged, wrapEntry, seenEvents)
}

export function mergeNestedConfig(
  agent: AgentDef,
  existingHooks: Record<string, any>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) continue
    const userGroups = stripManagedFromNestedGroups(groups)
    if (userGroups.length > 0) merged[event] = userGroups
  }
  addDispatchEntries(agent, merged, (cmd, timeout) => ({
    hooks: [{ type: "command", command: cmd, timeout, statusMessage: "Swizzling..." }],
  }))
  return merged
}

export function mergeFlatConfig(
  agent: AgentDef,
  existingHooks: Record<string, any>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue
    const userEntries = stripManagedFromFlatList(entries)
    if (userEntries.length > 0) merged[event] = userEntries
  }
  addDispatchEntries(agent, merged, (cmd, timeout) => ({
    command: cmd,
    timeout,
    statusMessage: "Swizzling...",
  }))
  return merged
}

export function mergeConfig(
  agent: AgentDef,
  existingHooks: Record<string, any>
): Record<string, unknown[]> {
  return agent.configStyle === "nested"
    ? mergeNestedConfig(agent, existingHooks)
    : mergeFlatConfig(agent, existingHooks)
}

export function collectNestedHooks(hooks: unknown[], cmds: Set<string>): void {
  for (const h of hooks) {
    const hh = h as Record<string, any>
    if (hh.command) cmds.add(String(hh.command))
  }
}

export function collectCommands(hooks: Record<string, any>): Set<string> {
  const cmds = new Set<string>()
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const e = entry as Record<string, any>
      if (e.command) cmds.add(String(e.command))
      if (Array.isArray(e.hooks)) collectNestedHooks(e.hooks, cmds)
    }
  }
  return cmds
}
