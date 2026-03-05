import { join } from "node:path"

const HOME = process.env.HOME ?? "~"

// ─── Agent definition ───────────────────────────────────────────────────────

export interface AgentDef {
  id: string
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
  /** Whether this agent supports user-configurable hooks via a settings file */
  hooksConfigurable: boolean
  /** One or more env vars — any being set (truthy) identifies this agent */
  envVars?: string[]
  /** Regex matched against the parent process command to identify this agent's shell */
  processPattern?: RegExp
}

// ─── Codex hooks status ─────────────────────────────────────────────────────
// Codex has AfterAgent and AfterToolUse events in its Rust hooks crate, but
// no user-facing config file for hooks yet (only programmatic Rust hooks).
// We include it here for tool name mapping and forward compatibility.

export const AGENTS: AgentDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    settingsPath: join(HOME, ".claude", "settings.json"),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "claude",
    hooksConfigurable: true,
    envVars: ["CLAUDECODE"],
    toolAliases: {},
    eventMap: {
      stop: "Stop",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      userPromptSubmit: "UserPromptSubmit",
      preCompact: "PreCompact",
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
    settingsPath: join(HOME, ".cursor", "hooks.json"),
    hooksKey: "hooks",
    wrapsHooks: { version: 1 },
    configStyle: "flat",
    binary: "cursor",
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
      subagentStart: "subagentStart",
      subagentStop: "subagentStop",
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    settingsPath: join(HOME, ".gemini", "settings.json"),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "gemini",
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
      subagentStart: "SubagentStart",
      subagentStop: "SubagentStop",
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    settingsPath: join(HOME, ".codex", "config.toml"),
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "codex",
    hooksConfigurable: false,
    envVars: ["CODEX_MANAGED_BY_NPM", "CODEX_THREAD_ID"],
    toolAliases: {
      Bash: "shell_command",
      Edit: "apply_patch",
      Write: "apply_patch",
      Read: "read_file",
      Grep: "grep_files",
      Glob: "list_dir",
      Task: "update_plan",
      TaskCreate: "update_plan",
      TaskUpdate: "update_plan",
      NotebookEdit: "apply_patch",
    },
    eventMap: {
      stop: "AfterAgent",
      postToolUse: "AfterToolUse",
      // Codex does not yet support pre-tool or session hooks
      preToolUse: "BeforeToolUse",
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      userPromptSubmit: "BeforeAgent",
      preCompact: "PreCompress",
    },
  },
]

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id)
}

export function getAgentByFlag(args: string[]): AgentDef[] {
  const explicit = AGENTS.filter((a) => args.includes(`--${a.id}`))
  return explicit.length > 0 ? explicit : AGENTS
}

/** Agents that support user-configurable hooks files */
export const CONFIGURABLE_AGENTS = AGENTS.filter((a) => a.hooksConfigurable)

// ─── Translation helpers ────────────────────────────────────────────────────

export function translateMatcher(matcher: string | undefined, agent: AgentDef): string | undefined {
  if (!matcher) return undefined
  return matcher.replace(/\b\w+\b/g, (tok) => agent.toolAliases[tok] ?? tok)
}

export function translateEvent(canonical: string, agent: AgentDef): string {
  return agent.eventMap[canonical] ?? canonical
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
