import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { AgentSettingsId } from "./agent-paths.ts"
import type { AgentDef } from "./agents.ts"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"

export type ProviderAgentId = AgentSettingsId
export type TranscriptProviderId = ProviderAgentId | "antigravity"

export interface ProviderConfig {
  agentId: ProviderAgentId
  configDir: string
  projectFiles: string[]
  ruleExtensions: string[]
  skillDir?: string
}

export interface ProviderRuleDirs {
  project: string | null
  global: string | null
}

export interface ProviderMemorySource {
  label: string
  path: string
}

export interface ProviderTaskRoots {
  tasksDir: string
  projectsDir: string
}

export interface ProviderAdapter {
  id: ProviderAgentId
  config: ProviderConfig
  getHomeDir(): string
  getProjectStateDir(projectDir: string): string
  getProjectFiles(projectDir: string): string[]
  getRuleDirs(projectDir: string): ProviderRuleDirs
  getMemorySources(projectDir: string): ProviderMemorySource[] | Promise<ProviderMemorySource[]>
  getTranscriptProviders(): Set<TranscriptProviderId>
  getSessionDir(): string
  getSkillDirs(): string[]
  getTaskRoots(): ProviderTaskRoots | null
}

function projectPath(projectDir: string, ...parts: string[]): string {
  return join(projectDir, ...parts)
}

async function scanRuleDir(dirPath: string, extensions: string[]): Promise<string[]> {
  if (!existsSync(dirPath)) return []

  const files: string[] = []
  try {
    for (const entry of await readdir(dirPath)) {
      if (extensions.some((ext) => entry.endsWith(ext))) {
        files.push(join(dirPath, entry))
      }
    }
  } catch {
    // Ignore read errors for optional provider directories.
  }

  return files
}

async function appendRuleDirEntries(
  sources: ProviderMemorySource[],
  dirPath: string,
  extensions: string[],
  missingDirLabel: string,
  labelForEntry: (entryName: string) => string
): Promise<void> {
  if (!existsSync(dirPath)) {
    sources.push({ label: missingDirLabel, path: dirPath })
    return
  }

  for (const file of await scanRuleDir(dirPath, extensions)) {
    sources.push({ label: labelForEntry(basename(file)), path: file })
  }
}

const CLAUDE_CONFIG: ProviderConfig = {
  agentId: "claude",
  configDir: ".claude",
  projectFiles: ["CLAUDE.md"],
  ruleExtensions: [".md"],
  skillDir: "skills",
}

const CURSOR_CONFIG: ProviderConfig = {
  agentId: "cursor",
  configDir: ".cursor",
  projectFiles: [".cursorrules"],
  ruleExtensions: [".md", ".mdc"],
  skillDir: "skills",
}

const GEMINI_CONFIG: ProviderConfig = {
  agentId: "gemini",
  configDir: ".gemini",
  projectFiles: ["GEMINI.md", ".gemini/GEMINI.md"],
  ruleExtensions: [".md"],
  skillDir: "skills",
}

const CODEX_CONFIG: ProviderConfig = {
  agentId: "codex",
  configDir: ".codex",
  projectFiles: ["AGENTS.md"],
  ruleExtensions: [".md"],
  skillDir: "skills",
}

const JUNIE_CONFIG: ProviderConfig = {
  agentId: "junie",
  configDir: ".junie",
  projectFiles: ["AGENTS.md"],
  ruleExtensions: [],
  skillDir: "skills",
}

const PROVIDER_ADAPTERS: Record<ProviderAgentId, ProviderAdapter> = {
  claude: {
    id: "claude",
    config: CLAUDE_CONFIG,
    getHomeDir() {
      return join(getHomeDir(), CLAUDE_CONFIG.configDir)
    },
    getProjectStateDir(projectDir: string) {
      return join(getHomeDir(), ".claude", "projects", projectKeyFromCwd(projectDir), "memory")
    },
    getProjectFiles(projectDir: string) {
      return CLAUDE_CONFIG.projectFiles.map((file) => projectPath(projectDir, file))
    },
    getRuleDirs() {
      return { project: null, global: null }
    },
    async getMemorySources(projectDir: string) {
      const memoryDir = this.getProjectStateDir(projectDir)
      const projectMemoryPath = join(memoryDir, "MEMORY.md")

      const sources: ProviderMemorySource[] = [
        { label: "Project rules", path: projectPath(projectDir, "CLAUDE.md") },
        { label: "Project memory", path: projectMemoryPath },
      ]

      for (const file of await scanRuleDir(memoryDir, this.config.ruleExtensions)) {
        if (file === projectMemoryPath) continue
        sources.push({ label: `Project memory (${basename(file)})`, path: file })
      }

      sources.push({ label: "Global rules", path: join(this.getHomeDir(), "CLAUDE.md") })
      return sources
    },
    getTranscriptProviders() {
      return new Set<TranscriptProviderId>(["claude"])
    },
    getSessionDir() {
      return join(getHomeDir(), ".claude", "projects")
    },
    getSkillDirs() {
      return [join(this.getHomeDir(), "skills")]
    },
    getTaskRoots() {
      return {
        tasksDir: join(this.getHomeDir(), "tasks"),
        projectsDir: join(this.getHomeDir(), "projects"),
      }
    },
  },

  cursor: {
    id: "cursor",
    config: CURSOR_CONFIG,
    getHomeDir() {
      return join(getHomeDir(), CURSOR_CONFIG.configDir)
    },
    getProjectStateDir(projectDir: string) {
      return projectDir
    },
    getProjectFiles(projectDir: string) {
      return CURSOR_CONFIG.projectFiles.map((file) => projectPath(projectDir, file))
    },
    getRuleDirs(projectDir: string) {
      return {
        project: join(projectDir, ".cursor", "rules"),
        global: join(this.getHomeDir(), "rules"),
      }
    },
    async getMemorySources(projectDir: string) {
      const sources: ProviderMemorySource[] = []

      for (const file of this.getProjectFiles(projectDir)) {
        sources.push({ label: "Project rules (.cursorrules)", path: file })
      }

      const ruleDirs = this.getRuleDirs(projectDir)
      if (ruleDirs.project) {
        await appendRuleDirEntries(
          sources,
          ruleDirs.project,
          this.config.ruleExtensions,
          "Project rules dir",
          (entryName) => `Project rule (${entryName})`
        )
      }

      if (ruleDirs.global) {
        await appendRuleDirEntries(
          sources,
          ruleDirs.global,
          this.config.ruleExtensions,
          "Global rules dir",
          (entryName) => `Global rule (${entryName})`
        )
      }

      return sources
    },
    getTranscriptProviders() {
      return new Set<TranscriptProviderId>(["cursor"])
    },
    getSessionDir() {
      return join(getHomeDir(), ".cursor", "chats")
    },
    getSkillDirs() {
      return [join(this.getHomeDir(), "skills")]
    },
    getTaskRoots() {
      return {
        tasksDir: join(this.getHomeDir(), "tasks"),
        projectsDir: this.getSessionDir(),
      }
    },
  },

  gemini: {
    id: "gemini",
    config: GEMINI_CONFIG,
    getHomeDir() {
      return join(getHomeDir(), GEMINI_CONFIG.configDir)
    },
    getProjectStateDir(projectDir: string) {
      return projectDir
    },
    getProjectFiles(projectDir: string) {
      return GEMINI_CONFIG.projectFiles.map((file) => projectPath(projectDir, file))
    },
    getRuleDirs(projectDir: string) {
      return {
        project: join(projectDir, ".gemini", "rules"),
        global: join(this.getHomeDir(), "rules"),
      }
    },
    getMemorySources(projectDir: string) {
      const sources: ProviderMemorySource[] = []

      for (const file of this.getProjectFiles(projectDir)) {
        if (!file.endsWith("GEMINI.md")) continue
        const label = file.includes(".gemini") ? "Project rules (.gemini/)" : "Project rules"
        sources.push({ label, path: file })
      }

      sources.push({ label: "Global rules", path: join(this.getHomeDir(), "GEMINI.md") })
      return sources
    },
    getTranscriptProviders() {
      return new Set<TranscriptProviderId>(["gemini", "antigravity"])
    },
    getSessionDir() {
      return this.getHomeDir()
    },
    getSkillDirs() {
      const antigravityRoot = join(this.getHomeDir(), "antigravity")
      return [
        join(this.getHomeDir(), "skills"),
        join(antigravityRoot, "skills"),
        join(antigravityRoot, "global_skills"),
      ]
    },
    getTaskRoots() {
      return {
        tasksDir: join(this.getHomeDir(), "tasks"),
        projectsDir: join(this.getHomeDir(), "projects"),
      }
    },
  },

  codex: {
    id: "codex",
    config: CODEX_CONFIG,
    getHomeDir() {
      return join(getHomeDir(), CODEX_CONFIG.configDir)
    },
    getProjectStateDir(projectDir: string) {
      return projectDir
    },
    getProjectFiles(projectDir: string) {
      return CODEX_CONFIG.projectFiles.map((file) => projectPath(projectDir, file))
    },
    getRuleDirs() {
      return { project: null, global: null }
    },
    getMemorySources(projectDir: string) {
      return [
        { label: "Project rules", path: projectPath(projectDir, "AGENTS.md") },
        { label: "Global rules", path: join(this.getHomeDir(), "AGENTS.md") },
        { label: "Global instructions", path: join(this.getHomeDir(), "instructions.md") },
      ]
    },
    getTranscriptProviders() {
      return new Set<TranscriptProviderId>(["codex"])
    },
    getSessionDir() {
      return this.getHomeDir()
    },
    getSkillDirs() {
      return [join(this.getHomeDir(), "skills")]
    },
    getTaskRoots() {
      return {
        tasksDir: join(this.getHomeDir(), "tasks"),
        projectsDir: join(this.getHomeDir(), "projects"),
      }
    },
  },
  junie: {
    id: "junie",
    config: JUNIE_CONFIG,
    getHomeDir() {
      return join(getHomeDir(), JUNIE_CONFIG.configDir)
    },
    getProjectStateDir() {
      return join(this.getHomeDir(), "misc")
    },
    getProjectFiles(projectDir: string) {
      return JUNIE_CONFIG.projectFiles.map((file) => projectPath(projectDir, file))
    },
    getRuleDirs() {
      return { project: null, global: null }
    },
    getMemorySources(projectDir: string) {
      const sources: ProviderMemorySource[] = [
        { label: "Project rules", path: projectPath(projectDir, "AGENTS.md") },
        { label: "Global rules", path: join(this.getHomeDir(), "AGENTS.md") },
        { label: "Allowlist", path: join(this.getHomeDir(), "allowlist.json") },
      ]
      return sources
    },
    getTranscriptProviders() {
      return new Set<TranscriptProviderId>(["junie"])
    },
    getSessionDir() {
      return join(this.getHomeDir(), "sessions")
    },
    getSkillDirs() {
      return [join(this.getHomeDir(), "skills")]
    },
    getTaskRoots() {
      return {
        tasksDir: join(this.getHomeDir(), "sessions"),
        projectsDir: join(this.getHomeDir(), "sessions"),
      }
    },
  },
}

function resolveProviderId(agent: AgentDef | string): ProviderAgentId | null {
  const agentId = typeof agent === "string" ? agent : agent.id
  return agentId in PROVIDER_ADAPTERS ? (agentId as ProviderAgentId) : null
}

export function getProviderAdapter(agent: AgentDef | string): ProviderAdapter | null {
  const id = resolveProviderId(agent)
  return id ? PROVIDER_ADAPTERS[id] : null
}

export function listProviderAdapters(): ProviderAdapter[] {
  return Object.values(PROVIDER_ADAPTERS)
}

export function getTranscriptProvidersForAgent(
  agent: AgentDef | string
): Set<TranscriptProviderId> {
  const adapter = getProviderAdapter(agent)
  return adapter ? adapter.getTranscriptProviders() : new Set<TranscriptProviderId>()
}

export function getProviderTaskRoots(agent: AgentDef | string): ProviderTaskRoots | null {
  const adapter = getProviderAdapter(agent)
  return adapter?.getTaskRoots() ?? null
}
