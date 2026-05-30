import { type AgentDef, translateEvent } from "../../agents.ts"
import { buildManifestForAgent, DISPATCH_TIMEOUTS } from "../../manifest.ts"
import { isManagedSwizCommand } from "../../swiz-hook-commands.ts"

/**
 * Strip swiz-managed and legacy hooks from a nested matcher group array,
 * returning only user-defined entries.
 */
function stripManagedFromNestedGroups(groups: unknown[]): unknown[] {
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
function stripManagedFromFlatList(entries: unknown[]): unknown[] {
  return entries.filter((e) => !isManagedSwizCommand((e as Record<string, any>).command))
}

function supportsAgentEvent(agent: AgentDef, canonicalEvent: string): boolean {
  const unsupported = new Set(agent.unsupportedEvents ?? [])
  return !unsupported.has(canonicalEvent) && canonicalEvent in agent.eventMap
}

function buildDispatchEntry(
  agent: AgentDef,
  canonicalEvent: string
): { eventName: string; timeout: number; cmd: string } {
  const timeoutScale = agent.id === "gemini" ? 1000 : 1
  const timeout = (DISPATCH_TIMEOUTS[canonicalEvent] ?? 30) * timeoutScale
  const eventName = translateEvent(canonicalEvent, agent)
  const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch --agent ${agent.id} ${canonicalEvent} ${eventName}`
  return { eventName, timeout, cmd }
}

function addAdditionalDispatchEntries(
  agent: AgentDef,
  merged: Record<string, unknown[]>,
  wrapEntry: (cmd: string, timeout: number) => unknown,
  seenEvents: Set<string>
): void {
  if (!agent.additionalDispatchEntries) return
  for (const [agentEventName, canonicalEvent] of Object.entries(agent.additionalDispatchEntries)) {
    if (!seenEvents.has(canonicalEvent)) continue
    const timeout = DISPATCH_TIMEOUTS[canonicalEvent] ?? 30
    const cmd = `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch --agent ${agent.id} ${canonicalEvent} ${agentEventName}`
    if (!merged[agentEventName]) merged[agentEventName] = []
    merged[agentEventName]!.push(wrapEntry(cmd, timeout))
  }
}

function addDispatchEntries(
  agent: AgentDef,
  merged: Record<string, unknown[]>,
  wrapEntry: (cmd: string, timeout: number) => unknown
): void {
  const seenEvents = new Set<string>()
  // Build the manifest for the *target* agent so a Claude shell installing
  // Codex hooks (or vice versa) emits the right shape. See #571.
  const agentManifest = buildManifestForAgent(agent)
  for (const group of agentManifest) {
    if (group.scheduled || seenEvents.has(group.event)) continue
    if (group.hooks.length === 0) continue
    seenEvents.add(group.event)
    if (!supportsAgentEvent(agent, group.event)) continue
    const { eventName, timeout, cmd } = buildDispatchEntry(agent, group.event)
    if (!merged[eventName]) merged[eventName] = []
    merged[eventName]!.push(wrapEntry(cmd, timeout))
  }

  addAdditionalDispatchEntries(agent, merged, wrapEntry, seenEvents)
}

function mergeNestedConfig(
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

function mergeFlatConfig(
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

/**
 * Strip swiz-managed entries from a lifecycle event array, tolerating both the
 * flat shape (`{type,command,timeout}`) and any leftover nested shape
 * (`{hooks:[...]}`) — agy normalizes hooks.json on load, so a re-install may see
 * either form for the same event.
 */
function stripManagedFromLifecycleList(entries: unknown[]): unknown[] {
  return entries.filter((entry) => {
    const e = entry as Record<string, any>
    if (Array.isArray(e.hooks)) {
      return e.hooks.some((h: Record<string, any>) => !isManagedSwizCommand(h.command))
    }
    return !isManagedSwizCommand(e.command)
  })
}

/**
 * Antigravity (`agy`) lifecycle config: each event holds a flat list of
 * `{type,command,timeout}` hook objects (no matcher wrapper). Only events agy
 * actually fires (Stop, PreInvocation, PostInvocation) are installed; agy strips
 * unknown fields like `statusMessage` on load, so we omit it.
 */
function mergeLifecycleConfig(
  agent: AgentDef,
  existingHooks: Record<string, any>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue
    const userEntries = stripManagedFromLifecycleList(entries)
    if (userEntries.length > 0) merged[event] = userEntries
  }
  addDispatchEntries(agent, merged, (cmd, timeout) => ({
    type: "command",
    command: cmd,
    timeout,
  }))
  return merged
}

export function mergeConfig(
  agent: AgentDef,
  existingHooks: Record<string, any>
): Record<string, unknown[]> {
  switch (agent.configStyle) {
    case "nested":
      return mergeNestedConfig(agent, existingHooks)
    case "flat-lifecycle":
      return mergeLifecycleConfig(agent, existingHooks)
    default:
      return mergeFlatConfig(agent, existingHooks)
  }
}

function collectNestedHooks(hooks: unknown[], cmds: Set<string>): void {
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
