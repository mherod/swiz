/**
 * Backwards-compatible provider utility wrappers.
 *
 * Provider behavior is now centralized in provider-adapters.ts.
 * Keep this module as a stable facade for existing imports.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentDef } from "./agents.ts"
import {
  getProviderAdapter,
  listProviderAdapters,
  type ProviderConfig,
} from "./provider-adapters.ts"

export type { ProviderConfig } from "./provider-adapters.ts"

/**
 * Get provider configuration for an agent.
 */
export function getProviderConfig(agent: AgentDef | string): ProviderConfig | null {
  return getProviderAdapter(agent)?.config ?? null
}

/**
 * Resolve the provider home directory.
 */
export function getProviderHome(agent: AgentDef | string): string {
  return getProviderAdapter(agent)?.getHomeDir() ?? ""
}

/**
 * Resolve the provider-specific project state/memory directory.
 */
export function getProviderProjectStateDir(agent: AgentDef | string, projectDir: string): string {
  return getProviderAdapter(agent)?.getProjectStateDir(projectDir) ?? projectDir
}

/**
 * Resolve provider-specific project file paths.
 */
export function getProviderProjectFiles(agent: AgentDef | string, projectDir: string): string[] {
  return getProviderAdapter(agent)?.getProjectFiles(projectDir) ?? []
}

/**
 * Scan a directory for provider rule/config files by configured extension.
 */
export function scanProviderRuleDir(agent: AgentDef | string, dirPath: string): string[] {
  const config = getProviderConfig(agent)
  if (!config || !existsSync(dirPath)) return []

  const files: string[] = []
  try {
    for (const entry of readdirSync(dirPath)) {
      if (config.ruleExtensions.some((ext) => entry.endsWith(ext))) {
        files.push(join(dirPath, entry))
      }
    }
  } catch {
    // Ignore read errors (permission denied, etc.)
  }

  return files
}

/**
 * Get provider-specific rule directories.
 */
export function getProviderRuleDirs(
  agent: AgentDef | string,
  projectDir: string
): { project: string | null; global: string | null } {
  return getProviderAdapter(agent)?.getRuleDirs(projectDir) ?? { project: null, global: null }
}

/**
 * Resolve provider-specific session/transcript storage root.
 */
export function getProviderSessionDir(agent: AgentDef | string): string {
  return getProviderAdapter(agent)?.getSessionDir() ?? ""
}

/**
 * Check whether a provider appears available locally.
 */
export function isProviderAvailable(agent: AgentDef | string): boolean {
  const home = getProviderHome(agent)
  return home ? existsSync(home) : false
}

/**
 * Get global skill directories for all configured providers.
 */
export function getAllProviderSkillDirs(): string[] {
  return listProviderAdapters().flatMap((adapter) => adapter.getSkillDirs())
}
