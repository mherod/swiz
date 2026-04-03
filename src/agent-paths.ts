import { join } from "node:path"
import { AGENTS, type AgentDef, inferAgentFromToolNames, translateMatcher } from "./agents.ts"
import { getHomeDir } from "./home.ts"

export type AgentSettingsId = "claude" | "cursor" | "gemini" | "codex" | "junie"

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
    case "junie":
      return join(homeDir, ".junie", "settings.json")
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
    case "junie":
      paths.push(
        join(homeDir, ".junie", "settings.local.json"),
        join(cwd, ".junie", "settings.json"),
        join(cwd, ".junie", "settings.local.json")
      )
      break
  }

  return paths
}

// ─── Agent detection utilities ───────────────────────────────────────────────

/**
 * Get the command that started the current process.
 * Used to detect agent context when environment variables aren't set.
 */
function getParentProcessCommand(): string {
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(process.ppid), "-o", "command="])
    return new TextDecoder().decode(proc.stdout).trim()
  } catch {
    return ""
  }
}

/**
 * Detect the current agent from environment variables only.
 * This is the safest signal inside hook subprocesses because it avoids
 * parent-process heuristics.
 */
export function detectCurrentAgentFromEnv(): AgentDef | null {
  return AGENTS.find((a) => a.envVars?.some((v) => process.env[v])) ?? null
}

/**
 * Detects the currently running agent by checking environment variables and parent process.
 *
 * Detection order:
 * 1. Environment variables (fast, reliable in hook contexts)
 * 2. Parent process command pattern (fallback when running in a shell)
 * 3. null if no agent detected
 */
export function detectCurrentAgent(): AgentDef | null {
  const byEnv = detectCurrentAgentFromEnv()
  if (byEnv) return byEnv

  // Fallback: check parent process command pattern
  const parentCmd = getParentProcessCommand()
  return AGENTS.find((a) => a.processPattern?.test(parentCmd)) ?? null
}

/**
 * Check if the current process is running inside a specific agent.
 */
export function isCurrentAgent(id: string): boolean {
  return detectCurrentAgent()?.id === id
}

/**
 * Check if running in any agent context (opposite of interactive shell).
 * This is a simpler check than detectCurrentAgent — just "are we in agent context?"
 *
 * Used by shell shims to decide whether to block or warn.
 */
export function isRunningInAgent(): boolean {
  // Non-interactive shell is almost certainly an agent
  if (!process.stdin.isTTY) return true

  // Check for known agent environment indicators
  if (process.env.CURSOR_TRACE_ID) return true
  if (process.env.CLAUDECODE) return true

  return false
}

/**
 * Resolve which agent to use for canonical → agent-specific tool name translation
 * (action plans, merged tasks). Same precedence as action-plan translation when
 * `translateToolNames` is enabled.
 */
export function resolveTranslationAgent(options?: {
  agent?: AgentDef | null
  observedToolNames?: Iterable<string>
}): AgentDef | null {
  const envAgent = detectCurrentAgentFromEnv()
  const inferredAgent =
    options?.observedToolNames !== undefined
      ? inferAgentFromToolNames(options.observedToolNames)
      : null
  const translationEnvAgent =
    envAgent && Object.keys(envAgent.toolAliases).length > 0 ? envAgent : null
  return options?.agent ?? translationEnvAgent ?? inferredAgent ?? detectCurrentAgent()
}

/**
 * Translate a canonical tool name to the agent-specific equivalent.
 * Returns the canonical name if no translation exists for the current agent.
 */
export function toolNameForCurrentAgent(canonicalName: string): string {
  const agent = detectCurrentAgent()
  if (!agent) return canonicalName
  return translateMatcher(canonicalName, agent) ?? canonicalName
}
