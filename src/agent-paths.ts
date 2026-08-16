import { join } from "node:path"
import { z } from "zod"
import {
  AGENTS,
  type AgentDef,
  agentSupportsTool,
  getAgent,
  inferAgentFromToolNames,
  translateMatcher,
  translateTaskToolName,
} from "./agents.ts"
import { getHomeDir } from "./home.ts"

export type AgentSettingsId = "claude" | "cursor" | "gemini" | "codex" | "antigravity"

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
    case "antigravity":
      // Antigravity stores hooks separately from settings.json, in its own
      // hooks.json under the antigravity-cli data dir.
      return join(homeDir, ".gemini", "antigravity-cli", "hooks.json")
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
    case "antigravity":
      paths.push(join(cwd, ".gemini", "antigravity-cli", "hooks.json"))
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

export const hookPayloadSchema = z.looseObject({
  _agent: z.string().optional(),
  _env: z.record(z.string(), z.string().optional()).optional(),
  transcript_path: z.string().optional(),
  tool_name: z.string().optional(),
  toolName: z.string().optional(),
})

export type HookPayload = z.infer<typeof hookPayloadSchema>

function getStringField(input: object | null | undefined, key: string): string {
  if (!input || typeof input !== "object") return ""
  const value = Reflect.get(input, key)
  return typeof value === "string" ? value : ""
}

function payloadEnv(
  input: object | null | undefined
): Record<string, string | undefined> | undefined {
  if (!input || typeof input !== "object") return undefined
  const env = Reflect.get(input, "_env")
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined

  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value
    }
  }
  return result
}

function detectCodexPayload(input: object | null | undefined): AgentDef | null {
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
 *
 * Fast path: if `_agent` is set on the payload (injected by `swiz dispatch
 * --agent <name>`), resolve it directly and skip env scanning.
 */
export function detectCurrentAgentFromHookPayload(
  input: object | null | undefined
): AgentDef | null {
  const explicitAgentId = getStringField(input, "_agent")
  if (explicitAgentId) {
    const found = getAgent(explicitAgentId)
    if (found) return found
  }
  const env = payloadEnv(input)
  const byPayloadEnv = env ? detectCurrentAgentFromEnv(env) : null
  if (byPayloadEnv) return byPayloadEnv
  return detectCodexPayload(input)
}

/**
 * Check whether the hook payload's originating agent has task tools.
 * Codex is modeled as task-enabled through its `update_plan` planning surface.
 */
export function agentHasTaskToolsForHookPayload(input: object | null | undefined): boolean {
  const agent = detectCurrentAgentFromHookPayload(input)
  if (!agent) return true
  return agent.tasksEnabled
}

/**
 * Codex task state is advisory at stop time because its planning surface cannot
 * reliably reconcile every persisted task record. Other agents retain the
 * incomplete-task stop gate, including unknown callers which default to Claude.
 */
export function shouldEnforceIncompleteTasksForHookPayload(
  input: object | null | undefined
): boolean {
  return detectCurrentAgentFromHookPayload(input)?.id !== "codex"
}

/**
 * True only when the agent is definitely Claude with a TaskList-capable surface.
 * Unknown callers return false — TaskList must not appear in action-plan steps.
 */
export function agentDefinitelySupportsTaskList(agent: AgentDef | null | undefined): boolean {
  return agent != null && agent.id === "claude" && agentSupportsTool(agent, "TaskList")
}

/**
 * Check whether the hook payload's originating agent has a TaskList-capable surface.
 * Unknown callers default to true so Claude-style sync enforcement still applies when
 * agent detection is inconclusive; use {@link agentDefinitelySupportsTaskList} for
 * action-plan copy.
 */
export function agentHasTaskListToolForHookPayload(input: HookPayload | undefined): boolean {
  const agent = detectCurrentAgentFromHookPayload(input)
  if (!agent) return true
  return agentDefinitelySupportsTaskList(agent)
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

export function taskToolNameForCurrentAgent(canonicalName: string): string | null {
  const agent = detectCurrentAgent()
  if (!agent) return canonicalName
  return translateTaskToolName(canonicalName, agent)
}

export function taskToolNameForHookPayload(
  input: HookPayload | undefined,
  canonicalName: string
): string | null {
  const agent = detectCurrentAgentFromHookPayload(input) ?? detectCurrentAgent()
  if (!agent) return canonicalName
  return translateTaskToolName(canonicalName, agent)
}
