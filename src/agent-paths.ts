import { join } from "node:path"
import {
  AGENTS,
  type AgentDef,
  getAgent,
  inferAgentFromToolNames,
  translateMatcher,
} from "./agents.ts"
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
export function detectCurrentAgentFromEnv(
  env: Record<string, string | undefined> = process.env
): AgentDef | null {
  return AGENTS.find((a) => a.envVars?.some((v) => env[v])) ?? null
}

/**
 * Check whether the current agent supports task tools (TaskCreate, TaskUpdate, etc.).
 * When no agent is detected from env, assumes task tools are available (Claude default).
 * Uses the agent's tasksEnabled property.
 */
export function agentHasTaskTools(): boolean {
  const agent = detectCurrentAgentFromEnv()
  if (!agent) return true
  return agent.tasksEnabled
}

type HookPayload = Record<string, unknown>

function getStringField(input: HookPayload | undefined, key: string): string {
  const value = input?.[key]
  return typeof value === "string" ? value : ""
}

function payloadEnv(
  input: HookPayload | undefined
): Record<string, string | undefined> | undefined {
  const env = input?._env
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined

  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value
    }
  }
  return result
}

function detectCodexPayload(input: HookPayload | undefined): AgentDef | null {
  const transcriptPath = getStringField(input, "transcript_path")
  if (transcriptPath.includes("/.codex/sessions/")) return getAgent("codex") ?? null

  const observedToolNames = [
    getStringField(input, "tool_name"),
    getStringField(input, "toolName"),
  ].filter(Boolean)
  const inferred = inferAgentFromToolNames(observedToolNames)
  return inferred?.id === "codex" ? inferred : null
}

/**
 * Detect the originating agent from a hook payload. Prefer payload `_env`
 * because daemon workers may not share the caller's environment. Fall back to
 * Codex transcript/tool-shape fingerprints for direct Codex hook payloads,
 * which do not always include CODEX_* env vars. Do not fall back to
 * process.env here: test runners and daemons can have ambient agent variables
 * that are not the hook caller.
 */
export function detectCurrentAgentFromHookPayload(input: HookPayload | undefined): AgentDef | null {
  const env = payloadEnv(input)
  const byPayloadEnv = env ? detectCurrentAgentFromEnv(env) : null
  if (byPayloadEnv) return byPayloadEnv
  return detectCodexPayload(input)
}

/**
 * Check whether the hook payload's originating agent has native task tools.
 * Codex must always return false here: `update_plan` is planning UI, not the
 * TaskCreate/TaskUpdate governance surface.
 */
export function agentHasTaskToolsForHookPayload(input: HookPayload | undefined): boolean {
  const agent = detectCurrentAgentFromHookPayload(input)
  if (!agent) return true
  return agent.tasksEnabled
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
