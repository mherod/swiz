/**
 * Provider utilities for multi-agent storage path resolution.
 *
 * This module provides reusable functions for discovering and accessing
 * provider-specific configuration files, memory, and session data across
 * different AI CLI tools (Claude Code, Cursor, Gemini, Codex, Antigravity).
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentDef } from "./agents.ts"
import { projectKeyFromCwd } from "./transcript-utils.ts"

function home(): string {
  return process.env.HOME ?? "~"
}

/**
 * Provider configuration defining paths and file patterns.
 * Extensible for new agents and alternative storage backends.
 */
export interface ProviderConfig {
  /** Agent ID (e.g., "claude", "gemini", "codex") */
  agentId: string

  /** Provider's config/home directory name (e.g., ".claude", ".gemini", ".cursor") */
  configDir: string

  /** Project-local file names for rules/config (e.g., CLAUDE.md, GEMINI.md, .cursorrules) */
  projectFiles: string[]

  /** File extensions to scan in rule directories (e.g., [".md", ".mdc"]) */
  ruleExtensions: string[]

  /** Skill directory name within provider home (e.g., "skills" for ~/.claude/skills) */
  skillDir?: string
}

/**
 * Maps agent IDs to their provider configurations.
 * Used to resolve paths and discover files across different agents.
 */
const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  claude: {
    agentId: "claude",
    configDir: ".claude",
    projectFiles: ["CLAUDE.md"],
    ruleExtensions: [".md"],
    skillDir: "skills",
  },
  cursor: {
    agentId: "cursor",
    configDir: ".cursor",
    projectFiles: [".cursorrules"],
    ruleExtensions: [".md", ".mdc"],
    skillDir: "skills",
  },
  gemini: {
    agentId: "gemini",
    configDir: ".gemini",
    projectFiles: ["GEMINI.md", ".gemini/GEMINI.md"],
    ruleExtensions: [".md"],
    skillDir: "skills",
  },
  codex: {
    agentId: "codex",
    configDir: ".codex",
    projectFiles: ["AGENTS.md"],
    ruleExtensions: [".md"],
    skillDir: "skills",
  },
}

/**
 * Get provider configuration for an agent.
 *
 * @param agent - Agent definition or agent ID string
 * @returns Provider configuration or null if not found
 */
export function getProviderConfig(agent: AgentDef | string): ProviderConfig | null {
  const agentId = typeof agent === "string" ? agent : agent.id
  return PROVIDER_CONFIGS[agentId] ?? null
}

/**
 * Resolve the global home directory path for a provider.
 *
 * @param agent - Agent definition or agent ID
 * @returns Path to provider's home directory (e.g., ~/.claude, ~/.gemini)
 */
export function getProviderHome(agent: AgentDef | string): string {
  const config = getProviderConfig(agent)
  if (!config) return ""
  return join(home(), config.configDir)
}

/**
 * Resolve the project memory/state directory for an agent.
 * For Claude: ~/.claude/projects/<projectKey>/memory
 * For others: project directory itself (rules/ subdirectory pattern varies)
 *
 * @param agent - Agent definition
 * @param projectDir - Project directory path
 * @returns Path to project state/memory directory
 */
export function getProviderProjectStateDir(agent: AgentDef | string, projectDir: string): string {
  const agentId = typeof agent === "string" ? agent : agent.id

  // Claude-specific: uses ~/.claude/projects/<key>/memory/
  if (agentId === "claude") {
    const projectKey = projectKeyFromCwd(projectDir)
    return join(home(), ".claude", "projects", projectKey, "memory")
  }

  // For other agents, rules are typically in project subdirectories
  // (e.g., .cursor/rules/, .gemini/rules/) — return project dir as base
  return projectDir
}

/**
 * Resolve provider-specific project file paths.
 * Returns all files in projectFiles array, relative to projectDir.
 *
 * @param agent - Agent definition
 * @param projectDir - Project directory
 * @returns Array of project file paths
 */
export function getProviderProjectFiles(agent: AgentDef | string, projectDir: string): string[] {
  const config = getProviderConfig(agent)
  if (!config) return []

  return config.projectFiles.map((file) => join(projectDir, file))
}

/**
 * Scan a directory for provider-specific rule/config files.
 * Filters by file extensions defined in provider config.
 *
 * @param agent - Agent definition
 * @param dirPath - Directory to scan
 * @returns Array of matching file paths, or empty if directory doesn't exist
 */
export function scanProviderRuleDir(agent: AgentDef | string, dirPath: string): string[] {
  const config = getProviderConfig(agent)
  if (!config || !existsSync(dirPath)) return []

  const files: string[] = []
  try {
    for (const entry of readdirSync(dirPath)) {
      // Check if entry matches any of the provider's allowed extensions
      const hasAllowedExt = config.ruleExtensions.some((ext) => entry.endsWith(ext))
      if (hasAllowedExt) {
        files.push(join(dirPath, entry))
      }
    }
  } catch {
    // Ignore read errors (permission denied, etc.)
  }

  return files
}

/**
 * Get all rule/config directories for a provider.
 * For providers like Cursor and Gemini that use subdirectories.
 *
 * @param agent - Agent definition
 * @param projectDir - Project directory
 * @returns Object with project and global rule directory paths
 */
export function getProviderRuleDirs(
  agent: AgentDef | string,
  projectDir: string
): { project: string | null; global: string | null } {
  const agentId = typeof agent === "string" ? agent : agent.id
  const config = getProviderConfig(agent)

  if (!config) return { project: null, global: null }

  // Build paths based on provider-specific subdirectory patterns
  const projectRulesDir =
    agentId === "cursor"
      ? join(projectDir, ".cursor", "rules")
      : agentId === "gemini"
        ? join(projectDir, ".gemini", "rules")
        : null

  const globalRulesDir =
    agentId === "cursor"
      ? join(home(), ".cursor", "rules")
      : agentId === "gemini"
        ? join(home(), ".gemini", "rules")
        : null

  return {
    project: projectRulesDir,
    global: globalRulesDir,
  }
}

/**
 * Resolve provider-specific session/transcript storage paths.
 * Each provider stores session data in different locations with different formats.
 *
 * @param agent - Agent definition
 * @returns Path to provider's session storage directory
 */
export function getProviderSessionDir(agent: AgentDef | string): string {
  const agentId = typeof agent === "string" ? agent : agent.id

  switch (agentId) {
    case "claude":
      // Claude stores sessions in ~/.claude/projects/<key>/ as .jsonl files
      // Caller must construct full path with projectKey
      return join(home(), ".claude", "projects")

    case "cursor":
      // Cursor sessions location (to be implemented)
      return join(home(), ".cursor", "sessions")

    case "gemini":
      // Gemini sessions in ~/.gemini/history/ or similar
      return join(home(), ".gemini")

    case "codex":
      // Codex has different session format — may be in ~/.codex/history.jsonl
      return join(home(), ".codex")

    default:
      return ""
  }
}

/**
 * Check if a provider is configured/available on the system.
 * Simply checks if the provider's home directory exists.
 *
 * @param agent - Agent definition or agent ID
 * @returns true if provider home directory exists
 */
export function isProviderAvailable(agent: AgentDef | string): boolean {
  const home = getProviderHome(agent)
  return home ? existsSync(home) : false
}

/**
 * Get all skill directories for all providers.
 * Returns both project-local and global skill directories.
 *
 * @returns Array of skill directory paths
 */
export function getAllProviderSkillDirs(): string[] {
  const skillDirs: string[] = []

  // Add skill directories for each configured provider
  for (const agent of Object.values(PROVIDER_CONFIGS)) {
    if (!agent.skillDir) continue

    // Add global skill directory for this provider
    const providerHome = join(home(), agent.configDir)
    const globalSkillDir = join(providerHome, agent.skillDir)
    skillDirs.push(globalSkillDir)

    // Antigravity extends Gemini with additional skill roots:
    // ~/.gemini/antigravity/skills and ~/.gemini/antigravity/global_skills
    // These come after ~/.gemini/skills in precedence order.
    if (agent.agentId === "gemini") {
      const antigravityRoot = join(providerHome, "antigravity")
      skillDirs.push(join(antigravityRoot, "skills"))
      skillDirs.push(join(antigravityRoot, "global_skills"))
    }
  }

  return skillDirs
}
