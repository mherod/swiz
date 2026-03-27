import { join } from "node:path"
import { getHomeDir } from "./home.ts"

export type AgentSettingsId = "claude" | "cursor" | "gemini" | "codex"

export interface AgentSettingsSearchOptions {
  cwd?: string
  homeDir?: string
}

export function getAgentSettingsPath(
  agentId: AgentSettingsId,
  homeDir: string = getHomeDir()
): string {
  switch (agentId) {
    case "claude":
      return join(homeDir, ".claude", "settings.json")
    case "cursor":
      return join(homeDir, ".cursor", "hooks.json")
    case "gemini":
      return join(homeDir, ".gemini", "settings.json")
    case "codex":
      return join(homeDir, ".codex", "hooks.json")
  }
}

export function getAgentSettingsSearchPaths(
  agentId: AgentSettingsId,
  options: AgentSettingsSearchOptions = {}
): string[] {
  const homeDir = options.homeDir ?? getHomeDir()
  const cwd = options.cwd ?? process.cwd()
  const paths = [getAgentSettingsPath(agentId, homeDir)]

  switch (agentId) {
    case "claude":
      paths.push(
        join(homeDir, ".claude", "settings.local.json"),
        join(cwd, ".claude", "settings.json"),
        join(cwd, ".claude", "settings.local.json")
      )
      break
    case "cursor":
      paths.push(join(cwd, ".cursor", "hooks.json"))
      break
    case "gemini":
      paths.push(join(cwd, ".gemini", "settings.json"))
      break
    case "codex":
      paths.push(join(cwd, ".codex", "hooks.json"))
      break
  }

  return paths
}
