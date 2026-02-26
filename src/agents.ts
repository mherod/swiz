import { join } from "node:path";

const HOME = process.env.HOME ?? "~";

// ─── Agent definition ───────────────────────────────────────────────────────

export interface AgentDef {
  id: string;
  name: string;
  settingsPath: string;
  /** JSON key path where hooks live inside the settings file */
  hooksKey: string;
  /** Whether the hooks object is wrapped (e.g. Cursor's { version: 1, hooks }) */
  wrapsHooks?: { version: number };
  /** Config structure uses nested matcher groups (Claude/Gemini) vs flat list (Cursor) */
  configStyle: "nested" | "flat";
  /** Binary name on PATH — used for auto-detection */
  binary: string;
  /** Tool name aliases: canonical (Claude-style) → agent-specific */
  toolAliases: Record<string, string>;
  /** Event name map: canonical → agent-specific */
  eventMap: Record<string, string>;
  /** Whether this agent supports user-configurable hooks via a settings file */
  hooksConfigurable: boolean;
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
  {
    id: "cursor",
    name: "Cursor",
    settingsPath: join(HOME, ".cursor", "hooks.json"),
    hooksKey: "hooks",
    wrapsHooks: { version: 1 },
    configStyle: "flat",
    binary: "cursor",
    hooksConfigurable: true,
    toolAliases: {
      Bash: "Shell",
      Edit: "StrReplace",
      NotebookEdit: "EditNotebook",
      Task: "TodoWrite",
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
    toolAliases: {
      Bash: "shell_command",
      Edit: "apply_patch",
      Write: "apply_patch",
      Read: "read_file",
      Grep: "grep_files",
      Glob: "list_dir",
      Task: "spawn_agent",
      TaskCreate: "spawn_agent",
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
];

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function getAgentByFlag(args: string[]): AgentDef[] {
  const explicit = AGENTS.filter((a) => args.includes(`--${a.id}`));
  return explicit.length > 0 ? explicit : AGENTS;
}

/** Agents that support user-configurable hooks files */
export const CONFIGURABLE_AGENTS = AGENTS.filter((a) => a.hooksConfigurable);

// ─── Translation helpers ────────────────────────────────────────────────────

export function translateMatcher(
  matcher: string | undefined,
  agent: AgentDef
): string | undefined {
  if (!matcher) return undefined;
  return matcher.replace(/\b\w+\b/g, (tok) => agent.toolAliases[tok] ?? tok);
}

export function translateEvent(
  canonical: string,
  agent: AgentDef
): string {
  return agent.eventMap[canonical] ?? canonical;
}

// ─── Agent detection ────────────────────────────────────────────────────────

export async function detectInstalledAgents(): Promise<AgentDef[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const proc = Bun.spawnSync(["which", agent.binary]);
        const found = proc.exitCode === 0;
        const settingsExist = await Bun.file(agent.settingsPath).exists();
        return found || settingsExist ? agent : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((a): a is AgentDef => a !== null);
}
