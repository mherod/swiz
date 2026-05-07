import { getAgentSettingsPath } from "./agent-paths.ts"
import { getHomeDir } from "./home.ts"

const HOME = getHomeDir()

export type AgentId = "claude" | "cursor" | "gemini" | "codex"

// ─── Agent definition ───────────────────────────────────────────────────────

export interface AgentDef {
  id: AgentId
  name: string
  settingsPath: string
  /** JSON key path where hooks live inside the settings file */
  hooksKey: string
  /** Whether the hooks object is wrapped (e.g. Cursor's { version: 1, hooks }) */
  wrapsHooks?: { version: number }
  /** Config structure uses nested matcher groups (Claude/Gemini) vs flat list (Cursor) */
  configStyle: "nested" | "flat"
  /** Binary name on PATH — used for auto-detection */
  binary: string
  /** Tool name aliases: canonical (Claude-style) → agent-specific */
  toolAliases: Record<string, string>
  /** Event name map: canonical → agent-specific */
  eventMap: Record<string, string>
  /** Canonical events intentionally unsupported by this agent runtime. */
  unsupportedEvents?: string[]
  /** Whether this agent supports tasks (TaskCreate, TaskUpdate, etc.) */
  tasksEnabled: boolean
  /** Whether this agent supports user-configurable hooks via a settings file */
  hooksConfigurable: boolean
  /** One or more env vars — any being set (truthy) identifies this agent */
  envVars?: string[]
  /** Regex matched against the parent process command to identify this agent's shell */
  processPattern?: RegExp
  /**
   * Additional agent event names that should dispatch to existing canonical events.
   * Map of agent-event-name → canonical-event.  Used to install extra dispatch entries
   * under alternative event names (e.g. Cursor CLI's `beforeShellExecution` dispatching
   * to the canonical `preToolUse` pipeline).
   */
  additionalDispatchEntries?: Record<string, string>
}

const PUBLIC_HOOK_EVENTS_BY_AGENT: Record<string, Set<string>> = {
  claude: new Set([
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreCompact",
    "Notification",
    "SubagentStart",
    "SubagentStop",
  ]),
  cursor: new Set([
    "stop",
    "preToolUse",
    "postToolUse",
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "preCompact",
    "afterAgentResponse",
    "subagentStart",
    "subagentStop",
    "beforeShellExecution",
    "afterShellExecution",
  ]),
  gemini: new Set([
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "PreCompress",
    "Notification",
  ]),
  codex: new Set(["Stop", "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]),
}

export function validatePublicAgentHookMappings(agents: AgentDef[]): void {
  for (const agent of agents) {
    const publicEvents = PUBLIC_HOOK_EVENTS_BY_AGENT[agent.id]
    if (!publicEvents) {
      throw new Error(`Agent "${agent.id}" is missing a public hook event allowlist.`)
    }

    for (const [canonicalEvent, agentEvent] of Object.entries(agent.eventMap)) {
      if (!publicEvents.has(agentEvent)) {
        throw new Error(
          `Agent "${agent.id}" eventMap["${canonicalEvent}"] references non-public hook event "${agentEvent}".`
        )
      }
    }

    for (const agentEvent of Object.keys(agent.additionalDispatchEntries ?? {})) {
      if (!publicEvents.has(agentEvent)) {
        throw new Error(
          `Agent "${agent.id}" additionalDispatchEntries references non-public hook event "${agentEvent}".`
        )
      }
    }
  }
}

function registerAgents(agents: AgentDef[]): AgentDef[] {
  validatePublicAgentHookMappings(agents)
  return agents
}

// ─── Codex hooks status ─────────────────────────────────────────────────────
// Codex's public hooks.json schema currently exposes exactly:
//   SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop.
// Swiz should only install against that public surface, even if Codex has
// additional internal engine identifiers behind the scenes.

export const AGENTS: AgentDef[] = registerAgents([
  {
    id: "claude",
    name: "Claude Code",
    settingsPath: getAgentSettingsPath("claude", HOME),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "claude",
    tasksEnabled: true,
    hooksConfigurable: true,
    envVars: ["CLAUDECODE"],
    toolAliases: {
      Skill: "Skill",
    },
    eventMap: {
      stop: "Stop",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      userPromptSubmit: "UserPromptSubmit",
      preCompact: "PreCompact",
      notification: "Notification",
      subagentStart: "SubagentStart",
      subagentStop: "SubagentStop",
    },
  },
  // ⚠ Cursor CLI (cursor-agent) only supports beforeShellExecution and
  // afterShellExecution hooks. All other events (preToolUse, postToolUse,
  // stop, sessionStart, etc.) only fire in the Cursor IDE.
  // Full CLI hook parity is on Cursor's roadmap with no ETA.
  // See: https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316
  {
    id: "cursor",
    name: "Cursor",
    settingsPath: getAgentSettingsPath("cursor", HOME),
    hooksKey: "hooks",
    wrapsHooks: { version: 1 },
    configStyle: "flat",
    binary: "cursor",
    tasksEnabled: true,
    hooksConfigurable: true,
    processPattern: /__CURSOR_SANDBOX_ENV_RESTORE/,
    toolAliases: {
      Bash: "Shell",
      Edit: "StrReplace",
      NotebookEdit: "EditNotebook",
      Task: "TodoWrite",
      TaskWrite: "TodoWrite",
      TaskCreate: "TodoWrite",
      TaskUpdate: "TodoWrite",
    },
    eventMap: {
      stop: "stop",
      preToolUse: "preToolUse",
      postToolUse: "postToolUse",
      sessionStart: "sessionStart",
      sessionEnd: "sessionEnd",
      userPromptSubmit: "beforeSubmitPrompt",
      preCompact: "preCompact",
      // Cursor has no "notification" hook type; map to a valid post-agent event.
      notification: "afterAgentResponse",
      subagentStart: "subagentStart",
      subagentStop: "subagentStop",
    },
    // Cursor CLI only fires beforeShellExecution/afterShellExecution.
    // Install additional dispatch entries under these event names so that
    // Bash-matcher preToolUse/postToolUse hooks fire in CLI mode.
    additionalDispatchEntries: {
      beforeShellExecution: "preToolUse",
      afterShellExecution: "postToolUse",
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    settingsPath: getAgentSettingsPath("gemini", HOME),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "gemini",
    tasksEnabled: true,
    hooksConfigurable: true,
    // GEMINI_CLI=1 is injected by shellExecutionService; GEMINI_PROJECT_DIR by hookRunner
    envVars: ["GEMINI_CLI", "GEMINI_PROJECT_DIR"],
    toolAliases: {
      Bash: "run_shell_command",
      Edit: "replace",
      Write: "write_file",
      Read: "read_file",
      Grep: "grep_search",
      Glob: "glob",
      Task: "write_todos",
      TaskCreate: "write_todos",
      TaskUpdate: "write_todos",
      NotebookEdit: "NotebookEdit", // no equivalent
    },
    eventMap: {
      stop: "AfterAgent",
      preToolUse: "BeforeTool",
      postToolUse: "AfterTool",
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      userPromptSubmit: "BeforeAgent",
      preCompact: "PreCompress",
      notification: "Notification",
    },
    unsupportedEvents: ["subagentStart", "subagentStop"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    settingsPath: getAgentSettingsPath("codex", HOME),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "codex",
    tasksEnabled: false,
    hooksConfigurable: true,
    envVars: ["CODEX_MANAGED_BY_NPM", "CODEX_THREAD_ID"],
    // Codex deliberately has no Task/TaskCreate/TaskUpdate aliases —
    // tasksEnabled=false and update_plan is planning UI, not a task surface
    // (see #570). The self-alias for update_plan keeps it in the emitted-tool
    // set for inferAgentFromToolNames without translating any canonical
    // task tool to it.
    toolAliases: {
      Bash: "shell_command",
      Edit: "apply_patch",
      Write: "apply_patch",
      Read: "read_file",
      Grep: "grep_files",
      Glob: "list_dir",
      NotebookEdit: "apply_patch",
      update_plan: "update_plan",
    },
    eventMap: {
      stop: "Stop",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      sessionStart: "SessionStart",
      userPromptSubmit: "UserPromptSubmit",
    },
    unsupportedEvents: [
      "sessionEnd",
      "preCompact",
      "notification",
      "subagentStart",
      "subagentStop",
    ],
  },
])

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id)
}

export function getAgentByFlag(args: string[]): AgentDef[] {
  const explicit = AGENTS.filter((a) => args.includes(`--${a.id}`))
  return explicit.length > 0 ? explicit : AGENTS
}

export function hasAnyAgentFlag(args: string[]): boolean {
  return args.some((arg) => AGENTS.some((agent) => `--${agent.id}` === arg))
}

/** Check if an agent supports a specific tool by name. */
export function agentSupportsTool(agent: AgentDef, toolName: string): boolean {
  // Claude (empty aliases or only Skill) supports canonical tools directly.
  if (agent.id === "claude") return true

  // If the agent has no explicit tool aliases, it is assumed to support
  // the canonical tool name directly — UNLESS it's the Skill tool,
  // which is currently unique to Claude Code.
  if (Object.keys(agent.toolAliases).length === 0) {
    return toolName !== "Skill"
  }

  // If the tool is explicitly aliased to itself, it's considered supported
  // (e.g. Gemini maps NotebookEdit to itself even if it's a no-op).
  if (agent.toolAliases[toolName] !== undefined) return true

  // Check if the toolName is one of the agent-specific names already
  return Object.values(agent.toolAliases).includes(toolName)
}

/** Agents that support user-configurable hooks files */
export const CONFIGURABLE_AGENTS = AGENTS.filter((a) => a.hooksConfigurable)

const CLAUDE_EMITTED_TOOL_NAMES = new Set([
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "NotebookEdit",
  "Skill",
])

const EMITTED_TOOL_NAMES_BY_AGENT = new Map(
  AGENTS.map((agent) => [
    agent.id,
    agent.id === "claude" ? CLAUDE_EMITTED_TOOL_NAMES : new Set(Object.values(agent.toolAliases)),
  ])
)

/** Get the set of tool names an agent emits (agent-specific names for aliased agents, canonical for Claude). */
export function getEmittedToolNames(agent: AgentDef): ReadonlySet<string> {
  return EMITTED_TOOL_NAMES_BY_AGENT.get(agent.id) ?? new Set()
}

// ─── Translation helpers ────────────────────────────────────────────────────

export function translateMatcher(matcher: string | undefined, agent: AgentDef): string | undefined {
  if (!matcher) return undefined
  return matcher.replace(/\b\w+\b/g, (tok) => agent.toolAliases[tok] ?? tok)
}

export function translateEvent(canonical: string, agent: AgentDef): string {
  return agent.eventMap[canonical] ?? canonical
}

/**
 * Infer the most likely agent from emitted tool names.
 *
 * Only tool names that uniquely identify a single agent count as evidence. This
 * keeps inline/daemon hook rendering conservative when the process environment
 * does not belong to the originating agent session.
 */
export function inferAgentFromToolNames(toolNames: Iterable<string>): AgentDef | null {
  const strongMatches = new Map<string, number>()

  for (const rawName of toolNames) {
    const name = rawName.trim()
    if (!name) continue

    const matchingAgents = AGENTS.filter((agent) =>
      EMITTED_TOOL_NAMES_BY_AGENT.get(agent.id)?.has(name)
    )
    if (matchingAgents.length !== 1) continue

    const agentId = matchingAgents[0]!.id
    strongMatches.set(agentId, (strongMatches.get(agentId) ?? 0) + 1)
  }

  if (strongMatches.size === 0) return null

  const rankedMatches = Array.from(strongMatches.entries()).sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return left[0].localeCompare(right[0])
  })

  const bestMatch = rankedMatches[0]
  const secondBestMatch = rankedMatches[1]
  if (!bestMatch) return null
  if (secondBestMatch && secondBestMatch[1] === bestMatch[1]) return null

  return getAgent(bestMatch[0]) ?? null
}

// ─── Agent detection ────────────────────────────────────────────────────────

/** Check if a single agent is installed (binary on PATH or settings file exists). */
export async function isAgentInstalled(agent: AgentDef): Promise<boolean> {
  try {
    const proc = Bun.spawnSync(["which", agent.binary])
    const found = proc.exitCode === 0
    const settingsExist = await Bun.file(agent.settingsPath).exists()
    return found || settingsExist
  } catch {
    return false
  }
}

export async function detectInstalledAgents(): Promise<AgentDef[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => ((await isAgentInstalled(agent)) ? agent : null))
  )
  return results.filter((a): a is AgentDef => a !== null)
}
