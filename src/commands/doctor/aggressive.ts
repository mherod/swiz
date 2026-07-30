import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { getAgentSettingsPath } from "../../agent-paths.ts"
import { type AgentDef, CONFIGURABLE_AGENTS } from "../../agents.ts"
import { getHomeDir } from "../../home.ts"
import { readJsonFile } from "../../utils/file-utils.ts"
import { collectCommands, mergeConfig } from "../install/config-helpers.ts"
import { writeWithBackup } from "../install/file-helpers.ts"
import { buildProposedAgentSettings, extractOldHooks } from "../install/settings-helpers.ts"

export interface AggressiveHookReplacement {
  agentName: string
  settingsPath: string
  removedHookCount: number
  installedHookCount: number
}

function countHookCommands(value: unknown, commands: Set<string> = new Set()): number {
  if (Array.isArray(value)) {
    for (const entry of value) countHookCommands(entry, commands)
    return commands.size
  }
  if (!value || typeof value !== "object") return commands.size

  const record = value as Record<string, unknown>
  if (typeof record.command === "string") commands.add(record.command)
  for (const nested of Object.values(record)) countHookCommands(nested, commands)
  return commands.size
}

/**
 * Replace every configurable agent's hook entries with a fresh swiz-only
 * configuration. Non-hook settings are preserved and existing files receive
 * the same `.bak` backup used by `swiz install`.
 */
export async function replaceAgentHooksWithSwiz(
  agents: AgentDef[] = CONFIGURABLE_AGENTS,
  homeDir: string = getHomeDir()
): Promise<AggressiveHookReplacement[]> {
  const replacements: AggressiveHookReplacement[] = []

  for (const agent of agents) {
    const resolvedAgent = {
      ...agent,
      settingsPath: getAgentSettingsPath(agent.id, homeDir),
    }
    const existing = await readJsonFile(resolvedAgent.settingsPath)
    const oldHooks = extractOldHooks(existing, resolvedAgent)
    const oldHookEntries = resolvedAgent.configStyle === "flat-lifecycle" ? existing : oldHooks
    const swizHooks = mergeConfig(resolvedAgent, {})
    const newText = buildProposedAgentSettings(existing, resolvedAgent, swizHooks, {
      replaceAllHookEntries: true,
    })

    await mkdir(dirname(resolvedAgent.settingsPath), { recursive: true })
    await writeWithBackup(resolvedAgent.settingsPath, `${newText}\n`)

    replacements.push({
      agentName: resolvedAgent.name,
      settingsPath: resolvedAgent.settingsPath,
      removedHookCount: countHookCommands(oldHookEntries),
      installedHookCount: collectCommands(swizHooks).size,
    })
  }

  return replacements
}
