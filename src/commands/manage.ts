import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type AgentSettingsId, getAgentSettingsPath } from "../agent-paths.ts"
import { stderrLog } from "../debug.ts"
import { getHomeDirOrNull } from "../home.ts"
import type { Command } from "../types.ts"

type ManageSubject = "mcp"
type ManageAction = "list" | "add" | "remove" | "validate" | "show" | "merge"
type AgentId = Exclude<AgentSettingsId, "codex"> | "claude-desktop" | "junie" | "ai"
type AgentScope = "global" | "project"

interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpFileData {
  mcpServers?: Record<string, McpServerDef>
  [key: string]: unknown
}

interface AgentConfig {
  id: AgentId
  scope: AgentScope
  flag: `--${AgentId}`
  displayName: string
  /** Resolves the config path given a base directory (home for global, cwd for project). */
  resolvePath: (base: string) => string
}

interface ParsedManageArgs {
  subject: ManageSubject
  action: ManageAction
  name?: string
  command?: string
  args: string[]
  env: Record<string, string>
  targetAgents: AgentId[]
  sourceAgents: AgentId[]
  /** When true, target project-scoped config files resolved from cwd. */
  project: boolean
}

const GLOBAL_AGENTS: AgentConfig[] = [
  {
    id: "cursor",
    scope: "global",
    flag: "--cursor",
    displayName: "Cursor",
    resolvePath: (home) => join(home, ".cursor", "mcp.json"),
  },
  {
    id: "claude",
    scope: "global",
    flag: "--claude",
    displayName: "Claude Code",
    resolvePath: (home) => join(home, ".claude.json"),
  },
  {
    id: "claude-desktop",
    scope: "global",
    flag: "--claude-desktop",
    displayName: "Claude Desktop",
    resolvePath: (home) =>
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  },
  {
    id: "gemini",
    scope: "global",
    flag: "--gemini",
    displayName: "Gemini CLI",
    resolvePath: (home) => getAgentSettingsPath("gemini", home),
  },
  {
    id: "junie",
    scope: "global",
    flag: "--junie",
    displayName: "Junie",
    resolvePath: (home) => join(home, ".junie", "mcp", "mcp.json"),
  },
  {
    id: "ai",
    scope: "global",
    flag: "--ai",
    displayName: "AI",
    resolvePath: (home) => join(home, ".ai", "mcp", "mcp.json"),
  },
]

/** Project-level MCP config files, resolved relative to the project root (cwd). */
const PROJECT_AGENTS: AgentConfig[] = [
  {
    id: "cursor",
    scope: "project",
    flag: "--cursor",
    displayName: "Cursor (project)",
    resolvePath: (cwd) => join(cwd, ".cursor", "mcp.json"),
  },
  {
    id: "claude",
    scope: "project",
    flag: "--claude",
    displayName: "Claude Code (project)",
    resolvePath: (cwd) => join(cwd, ".mcp.json"),
  },
  {
    id: "gemini",
    scope: "project",
    flag: "--gemini",
    displayName: "VS Code / Gemini (project)",
    resolvePath: (cwd) => join(cwd, ".vscode", "mcp.json"),
  },
  {
    id: "junie",
    scope: "project",
    flag: "--junie",
    displayName: "Junie (project)",
    resolvePath: (cwd) => join(cwd, ".junie", "mcp", "mcp.json"),
  },
  {
    id: "ai",
    scope: "project",
    flag: "--ai",
    displayName: "AI (project)",
    resolvePath: (cwd) => join(cwd, ".ai", "mcp", "mcp.json"),
  },
]

/** Returns the appropriate agent list for the given scope. */
function agentList(project: boolean): AgentConfig[] {
  return project ? PROJECT_AGENTS : GLOBAL_AGENTS
}

function usage(): string {
  return [
    "Usage: swiz manage mcp <list|show|add|remove|validate|merge> [options]",
    "Examples:",
    "  swiz manage mcp list",
    "  swiz manage mcp list --project",
    "  swiz manage mcp show figma --cursor",
    "  swiz manage mcp add figma --command npx --arg -y --arg @modelcontextprotocol/server-figma --env FIGMA_TOKEN=token --cursor",
    "  swiz manage mcp add figma --command npx --project --cursor",
    "  swiz manage mcp remove figma --claude --cursor",
    "  swiz manage mcp validate",
    "  swiz manage mcp validate --project",
    "  swiz manage mcp merge --from ai --junie",
    "  swiz manage mcp merge --from all --cursor --project",
    "Agent flags (optional): --cursor --claude --claude-desktop --gemini --junie --ai (default: all)",
    "Source flags (merge only): --from <agent|all>",
    "Scope flags (optional): --project (target project-level files; default: global home files)",
  ].join("\n")
}

function parseEnvAssignment(value: string): { key: string; val: string } {
  const idx = value.indexOf("=")
  if (idx <= 0) {
    throw new Error(`Invalid --env value "${value}". Expected KEY=VALUE`)
  }
  return { key: value.slice(0, idx), val: value.slice(idx + 1) }
}

interface ManageParseState {
  name?: string
  command?: string
  project: boolean
  actionArgs: string[]
  env: Record<string, string>
  selectedAgentFlags: Set<AgentId>
  sourceAgentFlags: Set<AgentId | "all">
}

function consumeManageValueFlag(
  token: string,
  next: string | undefined,
  state: ManageParseState
): number | null {
  if (token === "--command") {
    if (!next) throw new Error(`Missing value for --command\n${usage()}`)
    state.command = next
    return 1
  }
  if (token === "--arg") {
    if (!next) throw new Error(`Missing value for --arg\n${usage()}`)
    state.actionArgs.push(next)
    return 1
  }
  if (token === "--env") {
    if (!next) throw new Error(`Missing value for --env\n${usage()}`)
    const { key, val } = parseEnvAssignment(next)
    state.env[key] = val
    return 1
  }
  if (token === "--from") {
    if (!next) throw new Error(`Missing value for --from\n${usage()}`)
    if (next === "all") {
      state.sourceAgentFlags.add("all")
    } else {
      const agent = GLOBAL_AGENTS.find((a) => a.id === next || a.flag === `--${next}`)
      if (!agent) throw new Error(`Unknown source agent: ${next}\n${usage()}`)
      state.sourceAgentFlags.add(agent.id)
    }
    return 1
  }
  return null
}

function consumeManageFlag(
  token: string,
  next: string | undefined,
  state: ManageParseState
): number {
  if (token === "--project") {
    state.project = true
    return 0
  }

  const byFlag = GLOBAL_AGENTS.find((a) => a.flag === token)
  if (byFlag) {
    state.selectedAgentFlags.add(byFlag.id)
    return 0
  }

  const valueResult = consumeManageValueFlag(token, next, state)
  if (valueResult !== null) return valueResult

  if (token.startsWith("--")) throw new Error(`Unknown option: ${token}\n${usage()}`)
  if (!state.name) {
    state.name = token
    return 0
  }
  throw new Error(`Unexpected argument: ${token}\n${usage()}`)
}

const VALID_MCP_ACTIONS = new Set<ManageAction>([
  "list",
  "show",
  "add",
  "remove",
  "validate",
  "merge",
])
const ACTIONS_REQUIRING_NAME = new Set<ManageAction>(["add", "remove", "show"])

function validateManageAction(token: string): ManageAction {
  if (!VALID_MCP_ACTIONS.has(token as ManageAction)) {
    throw new Error(`Unknown mcp action: ${token}\n${usage()}`)
  }
  return token as ManageAction
}

function resolveTargetAgents(state: ManageParseState): AgentId[] {
  const agents = agentList(state.project)
  return state.selectedAgentFlags.size > 0
    ? agents.filter((a) => state.selectedAgentFlags.has(a.id)).map((a) => a.id)
    : agents.map((a) => a.id)
}

function resolveSourceAgents(state: ManageParseState): AgentId[] {
  const agents = agentList(state.project)
  if (state.sourceAgentFlags.has("all")) {
    return agents.map((a) => a.id)
  }
  return agents.filter((a) => state.sourceAgentFlags.has(a.id)).map((a) => a.id)
}

export function parseManageArgs(args: string[]): ParsedManageArgs {
  if (args[0] !== "mcp")
    throw new Error(`Unknown manage subject: ${args[0] ?? "(none)"}\n${usage()}`)

  const action = validateManageAction((args[1] ?? "list").toLowerCase())
  const state: ManageParseState = {
    project: false,
    actionArgs: [],
    env: {},
    selectedAgentFlags: new Set(),
    sourceAgentFlags: new Set(),
  }

  for (let i = 2; i < args.length; i++) {
    const token = args[i]
    if (!token) continue
    i += consumeManageFlag(token, args[i + 1], state)
  }

  if (ACTIONS_REQUIRING_NAME.has(action) && !state.name)
    throw new Error(`"${action}" requires a server name\n${usage()}`)
  if (action === "add" && !state.command)
    throw new Error(`"add" requires --command <cmd>\n${usage()}`)
  if (action === "merge" && state.sourceAgentFlags.size === 0) {
    throw new Error(`"merge" requires --from <agent|all>\n${usage()}`)
  }

  return {
    subject: "mcp",
    action,
    name: state.name,
    command: state.command,
    args: state.actionArgs,
    env: state.env,
    targetAgents: resolveTargetAgents(state),
    sourceAgents: resolveSourceAgents(state),
    project: state.project,
  }
}

async function readMcpFile(path: string): Promise<McpFileData> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  const json = (await file.json()) as unknown
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`Invalid JSON object in ${path}`)
  }
  return json as McpFileData
}

async function writeMcpFile(path: string, value: McpFileData): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function getAgentConfig(agentId: AgentId, project: boolean): AgentConfig {
  const agents = agentList(project)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)
  return agent
}

function validateServerEnv(name: string, env: unknown, issues: string[]): void {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    issues.push(`Server "${name}" has invalid env (must be object of strings)`)
    return
  }
  for (const [envKey, envVal] of Object.entries(env as Record<string, any>)) {
    if (typeof envVal !== "string") issues.push(`Server "${name}" env "${envKey}" must be a string`)
  }
}

function validateServerShape(name: string, server: unknown, issues: string[]): void {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    issues.push(`Server "${name}" is not an object`)
    return
  }
  const value = server as Record<string, any>
  if (typeof value.command !== "string" || value.command.trim() === "") {
    issues.push(`Server "${name}" is missing a non-empty command`)
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))
  ) {
    issues.push(`Server "${name}" has invalid args (must be string[])`)
  }
  if (value.env !== undefined) validateServerEnv(name, value.env, issues)
}

function validateServerBinary(name: string, server: McpServerDef, issues: string[]): void {
  const command = server.command.trim()
  if (!command) return
  if (command.includes("/") || command.startsWith(".")) return
  const found = Bun.which(command)
  if (!found) {
    issues.push(`Server "${name}" command "${command}" is not on PATH`)
  }
}

async function listMcpServers(
  targetAgents: AgentId[],
  base: string,
  project: boolean
): Promise<void> {
  for (const agentId of targetAgents) {
    const agent = getAgentConfig(agentId, project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const servers = json.mcpServers ?? {}
    const names = Object.keys(servers)
    console.log(`\n${agent.displayName} (${path})`)
    if (names.length === 0) {
      console.log("  (no MCP servers)")
      continue
    }
    for (const name of names.sort()) {
      const server = servers[name]
      const cmd = server?.command ?? "(missing command)"
      console.log(`  - ${name}: ${cmd}`)
    }
  }
  console.log("")
}

async function showMcpServer(
  targetAgents: AgentId[],
  base: string,
  project: boolean,
  name: string
): Promise<void> {
  for (const agentId of targetAgents) {
    const agent = getAgentConfig(agentId, project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const server = json.mcpServers?.[name]
    console.log(`\n${agent.displayName} (${path})`)
    if (!server) {
      console.log(`  ${name}: not configured`)
      continue
    }
    console.log(`  ${name}:`)
    console.log(`    command: ${server.command}`)
    if (server.args?.length) {
      console.log(`    args: ${server.args.join(" ")}`)
    }
    if (server.env && Object.keys(server.env).length > 0) {
      const envPairs = Object.entries(server.env)
        .map(([key, val]) => `${key}=${val}`)
        .join(", ")
      console.log(`    env: ${envPairs}`)
    }
  }
  console.log("")
}

async function addMcpServer(parsed: ParsedManageArgs, base: string): Promise<void> {
  const name = parsed.name!
  const command = parsed.command!
  for (const agentId of parsed.targetAgents) {
    const agent = getAgentConfig(agentId, parsed.project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const mcpServers = { ...(json.mcpServers ?? {}) }
    const server: McpServerDef = { command }
    if (parsed.args.length > 0) server.args = parsed.args
    if (Object.keys(parsed.env).length > 0) server.env = parsed.env
    mcpServers[name] = server
    await writeMcpFile(path, { ...json, mcpServers })
    console.log(`Added "${name}" to ${agent.displayName} (${path})`)
  }
}

async function removeMcpServer(parsed: ParsedManageArgs, base: string): Promise<void> {
  const name = parsed.name!
  for (const agentId of parsed.targetAgents) {
    const agent = getAgentConfig(agentId, parsed.project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const mcpServers = { ...(json.mcpServers ?? {}) }
    if (!(name in mcpServers)) {
      console.log(`"${name}" not found in ${agent.displayName} (${path})`)
      continue
    }
    delete mcpServers[name]
    await writeMcpFile(path, { ...json, mcpServers })
    console.log(`Removed "${name}" from ${agent.displayName} (${path})`)
  }
}

async function validateMcpServers(parsed: ParsedManageArgs, base: string): Promise<void> {
  const issues: string[] = []
  for (const agentId of parsed.targetAgents) {
    const agent = getAgentConfig(agentId, parsed.project)
    const path = agent.resolvePath(base)
    try {
      const json = await readMcpFile(path)
      const servers = json.mcpServers ?? {}
      for (const [name, server] of Object.entries(servers)) {
        const prefixed = `${agent.displayName} (${path}): `
        const localIssues: string[] = []
        validateServerShape(name, server, localIssues)
        if (localIssues.length === 0) {
          validateServerBinary(name, server as McpServerDef, localIssues)
        }
        issues.push(...localIssues.map((msg) => prefixed + msg))
      }
    } catch (error) {
      issues.push(`${agent.displayName} (${path}): ${(error as Error).message}`)
    }
  }

  if (issues.length === 0) {
    console.log("MCP validation passed.")
    return
  }

  for (const issue of issues) {
    stderrLog("manage validate emits validation failures to stderr", `- ${issue}`)
  }
  throw new Error(`MCP validation failed with ${issues.length} issue(s)`)
}

async function mergeMcpServers(parsed: ParsedManageArgs, base: string): Promise<void> {
  const sourceServers: Record<string, McpServerDef> = {}

  // 1. Gather all unique servers from source agents
  for (const agentId of parsed.sourceAgents) {
    const agent = getAgentConfig(agentId, parsed.project)
    const path = agent.resolvePath(base)
    try {
      const json = await readMcpFile(path)
      const servers = json.mcpServers ?? {}
      for (const [name, server] of Object.entries(servers)) {
        // Simple merge: later sources overwrite earlier ones if there's a collision
        // in source list, but we usually expect unique names or identical configs.
        sourceServers[name] = server
      }
    } catch (error) {
      stderrLog(
        "manage",
        `Warning: Could not read source config for ${agent.displayName}: ${error}`
      )
    }
  }

  if (Object.keys(sourceServers).length === 0) {
    console.log("No MCP servers found in source agents to merge.")
    return
  }

  // 2. Merge into target agents
  for (const agentId of parsed.targetAgents) {
    // Skip if target is one of the sources (unless it's the only target and we want to consolidate)
    // Actually, usually we merge into a specific target.
    // If user didn't specify target agents, it defaults to all.
    // We should probably only merge into targets that weren't the ONLY source.

    const agent = getAgentConfig(agentId, parsed.project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const mcpServers = { ...(json.mcpServers ?? {}) }

    let addedCount = 0
    let updatedCount = 0

    for (const [name, server] of Object.entries(sourceServers)) {
      if (mcpServers[name]) {
        // Check if it's actually different
        if (JSON.stringify(mcpServers[name]) !== JSON.stringify(server)) {
          updatedCount++
        } else {
          continue
        }
      } else {
        addedCount++
      }
      mcpServers[name] = server
    }

    if (addedCount > 0 || updatedCount > 0) {
      await writeMcpFile(path, { ...json, mcpServers })
      console.log(
        `Merged ${addedCount} new and ${updatedCount} updated servers into ${agent.displayName} (${path})`
      )
    } else {
      console.log(`${agent.displayName} (${path}) is already up to date.`)
    }
  }
}

const SWIZ_MCP_SERVER_NAME = "swiz"
const SWIZ_MCP_SERVER_DEF: McpServerDef = { command: "swiz", args: ["mcp"] }

function mcpServersEqual(a: McpServerDef, b: McpServerDef): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Register swiz as an MCP server in each target agent's config file.
 * Idempotent: no-ops when the existing entry already matches. Used by
 * `swiz install` so fresh agents pick up the `swiz mcp` stdio server.
 */
export async function installSwizAsMcpServer(
  targetAgentIds: AgentId[],
  base: string,
  project: boolean,
  dryRun: boolean
): Promise<{ updated: string[]; skipped: string[] }> {
  const updated: string[] = []
  const skipped: string[] = []
  for (const agentId of targetAgentIds) {
    const agent = getAgentConfig(agentId, project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    const mcpServers = { ...(json.mcpServers ?? {}) }
    const existing = mcpServers[SWIZ_MCP_SERVER_NAME]
    if (existing && mcpServersEqual(existing, SWIZ_MCP_SERVER_DEF)) {
      skipped.push(`${agent.displayName} (${path})`)
      continue
    }
    mcpServers[SWIZ_MCP_SERVER_NAME] = SWIZ_MCP_SERVER_DEF
    if (!dryRun) await writeMcpFile(path, { ...json, mcpServers })
    updated.push(`${agent.displayName} (${path})`)
  }
  return { updated, skipped }
}

/** Remove the swiz MCP server entry from each target agent's config file. */
export async function uninstallSwizAsMcpServer(
  targetAgentIds: AgentId[],
  base: string,
  project: boolean,
  dryRun: boolean
): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const agentId of targetAgentIds) {
    const agent = getAgentConfig(agentId, project)
    const path = agent.resolvePath(base)
    const json = await readMcpFile(path)
    if (!json.mcpServers?.[SWIZ_MCP_SERVER_NAME]) continue
    const mcpServers = { ...json.mcpServers }
    delete mcpServers[SWIZ_MCP_SERVER_NAME]
    if (!dryRun) await writeMcpFile(path, { ...json, mcpServers })
    removed.push(`${agent.displayName} (${path})`)
  }
  return { removed }
}

/** Agent IDs that `manage mcp` knows how to configure globally. */
export const MCP_MANAGED_AGENT_IDS: AgentId[] = GLOBAL_AGENTS.map((a) => a.id)

export const manageCommand: Command = {
  name: "manage",
  description: "Manage shared swiz resources (MCP, etc.)",
  usage: "swiz manage mcp <list|show|add|remove|validate|merge> [options]",
  options: [
    { flags: "mcp list", description: "List configured MCP servers across target agents" },
    { flags: "mcp show <name>", description: "Show a single MCP server definition" },
    {
      flags: "mcp add <name> --command <cmd> [--arg ...] [--env KEY=VALUE]",
      description: "Add or update an MCP server entry",
    },
    { flags: "mcp remove <name>", description: "Remove an MCP server entry" },
    { flags: "mcp validate", description: "Validate MCP server configuration files" },
    {
      flags: "mcp merge --from <agent|all>",
      description: "Merge MCP servers from source agent(s) into target agents",
    },
    {
      flags: "--cursor --claude --claude-desktop --gemini --junie --ai",
      description: "Limit action to selected agents",
    },
    {
      flags: "--from <agent|all>",
      description: "Specify source agent(s) for merge",
    },
    {
      flags: "--project",
      description:
        "Target project-level config files (.cursor/mcp.json, .mcp.json, .vscode/mcp.json, .junie/mcp/mcp.json, .ai/mcp/mcp.json)",
    },
  ],
  async run(args) {
    const parsed = parseManageArgs(args)
    const home = getHomeDirOrNull()
    if (!home) throw new Error("HOME is not set; cannot manage MCP configuration.")

    if (parsed.subject !== "mcp") {
      throw new Error(`Unsupported manage subject: ${parsed.subject}`)
    }

    // Project-scoped actions resolve paths relative to cwd; global actions use home.
    const base = parsed.project ? process.cwd() : home

    switch (parsed.action) {
      case "list":
        return listMcpServers(parsed.targetAgents, base, parsed.project)
      case "show":
        return showMcpServer(parsed.targetAgents, base, parsed.project, parsed.name!)
      case "add":
        return addMcpServer(parsed, base)
      case "remove":
        return removeMcpServer(parsed, base)
      case "validate":
        return validateMcpServers(parsed, base)
      case "merge":
        return mergeMcpServers(parsed, base)
    }
  },
}
