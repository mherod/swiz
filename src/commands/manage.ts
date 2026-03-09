import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "../home.ts"
import type { Command } from "../types.ts"

type ManageSubject = "mcp"
type ManageAction = "list" | "add" | "remove" | "validate" | "show"
type AgentId = "cursor" | "claude" | "gemini"
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
    id: "gemini",
    scope: "global",
    flag: "--gemini",
    displayName: "Gemini CLI",
    resolvePath: (home) => join(home, ".gemini", "settings.json"),
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
]

/** Returns the appropriate agent list for the given scope. */
function agentList(project: boolean): AgentConfig[] {
  return project ? PROJECT_AGENTS : GLOBAL_AGENTS
}

function usage(): string {
  return [
    "Usage: swiz manage mcp <list|show|add|remove|validate> [options]",
    "Examples:",
    "  swiz manage mcp list",
    "  swiz manage mcp list --project",
    "  swiz manage mcp show figma --cursor",
    "  swiz manage mcp add figma --command npx --arg -y --arg @modelcontextprotocol/server-figma --env FIGMA_TOKEN=token --cursor",
    "  swiz manage mcp add figma --command npx --project --cursor",
    "  swiz manage mcp remove figma --claude --cursor",
    "  swiz manage mcp validate",
    "  swiz manage mcp validate --project",
    "Agent flags (optional): --cursor --claude --gemini (default: all)",
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

export function parseManageArgs(args: string[]): ParsedManageArgs {
  if (args[0] !== "mcp") {
    throw new Error(`Unknown manage subject: ${args[0] ?? "(none)"}\n${usage()}`)
  }

  const actionToken = (args[1] ?? "list").toLowerCase()
  if (
    actionToken !== "list" &&
    actionToken !== "show" &&
    actionToken !== "add" &&
    actionToken !== "remove" &&
    actionToken !== "validate"
  ) {
    throw new Error(`Unknown mcp action: ${actionToken}\n${usage()}`)
  }

  const action = actionToken as ManageAction
  let name: string | undefined
  let command: string | undefined
  let project = false
  const actionArgs: string[] = []
  const env: Record<string, string> = {}
  const selectedAgentFlags = new Set<AgentId>()

  for (let i = 2; i < args.length; i++) {
    const token = args[i]
    if (!token) continue

    if (token === "--project") {
      project = true
      continue
    }

    const byFlag = GLOBAL_AGENTS.find((a) => a.flag === token)
    if (byFlag) {
      selectedAgentFlags.add(byFlag.id)
      continue
    }

    if (token === "--command") {
      const value = args[i + 1]
      if (!value) throw new Error(`Missing value for --command\n${usage()}`)
      command = value
      i++
      continue
    }

    if (token === "--arg") {
      const value = args[i + 1]
      if (!value) throw new Error(`Missing value for --arg\n${usage()}`)
      actionArgs.push(value)
      i++
      continue
    }

    if (token === "--env") {
      const value = args[i + 1]
      if (!value) throw new Error(`Missing value for --env\n${usage()}`)
      const { key, val } = parseEnvAssignment(value)
      env[key] = val
      i++
      continue
    }

    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}\n${usage()}`)
    }

    if (!name) {
      name = token
      continue
    }

    throw new Error(`Unexpected extra argument: ${token}\n${usage()}`)
  }

  if ((action === "add" || action === "remove" || action === "show") && !name) {
    throw new Error(`"${action}" requires a server name\n${usage()}`)
  }
  if (action === "add" && !command) {
    throw new Error(`"add" requires --command <cmd>\n${usage()}`)
  }

  const agents = agentList(project)
  const targetAgents =
    selectedAgentFlags.size > 0
      ? agents.filter((a) => selectedAgentFlags.has(a.id)).map((a) => a.id)
      : agents.map((a) => a.id)

  return {
    subject: "mcp",
    action,
    name,
    command,
    args: actionArgs,
    env,
    targetAgents,
    project,
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

function validateServerShape(name: string, server: unknown, issues: string[]): void {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    issues.push(`Server "${name}" is not an object`)
    return
  }
  const value = server as Record<string, unknown>
  if (typeof value.command !== "string" || value.command.trim() === "") {
    issues.push(`Server "${name}" is missing a non-empty command`)
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))
  ) {
    issues.push(`Server "${name}" has invalid args (must be string[])`)
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) {
      issues.push(`Server "${name}" has invalid env (must be object of strings)`)
    } else {
      for (const [envKey, envVal] of Object.entries(value.env as Record<string, unknown>)) {
        if (typeof envVal !== "string") {
          issues.push(`Server "${name}" env "${envKey}" must be a string`)
        }
      }
    }
  }
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
    console.error(`- ${issue}`)
  }
  throw new Error(`MCP validation failed with ${issues.length} issue(s)`)
}

export const manageCommand: Command = {
  name: "manage",
  description: "Manage shared swiz resources (MCP, etc.)",
  usage: "swiz manage mcp <list|show|add|remove|validate> [options]",
  options: [
    { flags: "mcp list", description: "List configured MCP servers across target agents" },
    { flags: "mcp show <name>", description: "Show a single MCP server definition" },
    {
      flags: "mcp add <name> --command <cmd> [--arg ...] [--env KEY=VALUE]",
      description: "Add or update an MCP server entry",
    },
    { flags: "mcp remove <name>", description: "Remove an MCP server entry" },
    { flags: "mcp validate", description: "Validate MCP server configuration files" },
    { flags: "--cursor --claude --gemini", description: "Limit action to selected agents" },
    {
      flags: "--project",
      description:
        "Target project-level config files (.cursor/mcp.json, .mcp.json, .vscode/mcp.json)",
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
    }
  },
}
