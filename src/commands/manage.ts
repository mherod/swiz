import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type AgentSettingsId, getAgentSettingsPath } from "../agent-paths.ts"
import { detectInstalledAgents } from "../agents.ts"
import { stderrLog } from "../debug.ts"
import { getHomeDirOrNull } from "../home.ts"
import type { Command } from "../types.ts"
import {
  type McpFileData,
  type McpServerDef,
  portableServers,
  readMcpFile,
  renderMcpFile,
  writeMcpFile,
} from "./mcp-config.ts"

type ManageSubject = "mcp"
type ManageAction = "list" | "add" | "remove" | "validate" | "show" | "merge" | "sync"
type AgentId = AgentSettingsId | "claude-desktop" | "junie" | "ai"
type AgentScope = "global" | "project"

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
  explicitTargets: boolean
  dryRun: boolean
}

const GLOBAL_AGENTS: AgentConfig[] = [
  {
    id: "antigravity",
    scope: "global",
    flag: "--antigravity",
    displayName: "Antigravity",
    resolvePath: (base) => join(base, ".gemini", "config", "mcp_config.json"),
  },
  {
    id: "codex",
    scope: "global",
    flag: "--codex",
    displayName: "Codex",
    resolvePath: (base) => join(base, ".codex", "config.toml"),
  },
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
    id: "antigravity",
    scope: "project",
    flag: "--antigravity",
    displayName: "Antigravity (project)",
    resolvePath: (base) => join(base, ".agents", "mcp_config.json"),
  },
  {
    id: "codex",
    scope: "project",
    flag: "--codex",
    displayName: "Codex (project)",
    resolvePath: (base) => join(base, ".codex", "config.toml"),
  },
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
    "Usage: swiz manage mcp <list|show|add|remove|validate|merge|sync> [options]",
    "Examples:",
    "  swiz manage mcp list --agy",
    "  swiz manage mcp sync --dry-run",
    "  swiz manage mcp merge --from agy --codex",
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
    "Agent flags (optional): --cursor --claude --claude-desktop --gemini --junie --ai --antigravity --agy --codex (default: all)",
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
  dryRun: boolean
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
  const consumers = new Map<string, (value: string) => void>([
    [
      "--command",
      (value) => {
        state.command = value
      },
    ],
    ["--arg", (value) => state.actionArgs.push(value)],
    [
      "--env",
      (value) => {
        const { key, val } = parseEnvAssignment(value)
        state.env[key] = val
      },
    ],
    ["--from", (value) => consumeSourceAgent(value, state)],
  ])
  const consume = consumers.get(token)
  if (!consume) return null
  if (!next) throw new Error(`Missing value for ${token}\n${usage()}`)
  consume(next)
  return 1
}

function consumeSourceAgent(value: string, state: ManageParseState): void {
  if (value === "agy") value = "antigravity"
  if (value === "all") {
    state.sourceAgentFlags.add("all")
    return
  }
  const agent = GLOBAL_AGENTS.find(
    (candidate) => candidate.id === value || candidate.flag === `--${value}`
  )
  if (!agent) throw new Error(`Unknown source agent: ${value}\n${usage()}`)
  state.sourceAgentFlags.add(agent.id)
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

  if (token === "--dry-run") {
    state.dryRun = true
    return 0
  }
  const byFlag = GLOBAL_AGENTS.find((a) => a.flag === (token === "--agy" ? "--antigravity" : token))
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
  "sync",
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
    dryRun: false,
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

  validateManageParseState(action, state)

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
    explicitTargets: state.selectedAgentFlags.size > 0,
    dryRun: state.dryRun,
  }
}

function validateManageOptions(action: ManageAction, state: ManageParseState): void {
  if (state.project && state.selectedAgentFlags.has("claude-desktop"))
    throw new Error("Claude Desktop has no project MCP configuration")
  if (action === "sync" && state.sourceAgentFlags.size)
    throw new Error("sync uses participating agents as sources; use merge for --from")
  if (state.dryRun && action !== "sync" && action !== "merge")
    throw new Error("--dry-run supports sync and merge only")
}

function validateManageParseState(action: ManageAction, state: ManageParseState): void {
  validateManageOptions(action, state)
  if (ACTIONS_REQUIRING_NAME.has(action) && !state.name) {
    throw new Error(`"${action}" requires a server name\n${usage()}`)
  }
  if (action === "add" && !state.command) {
    throw new Error(`"add" requires --command <cmd>\n${usage()}`)
  }
  if (action === "merge" && state.sourceAgentFlags.size === 0) {
    throw new Error(`"merge" requires --from <agent|all>\n${usage()}`)
  }
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

function validateServerBinary(
  name: string,
  server: McpServerDef,
  issues: string[],
  which: (command: string) => string | null
): void {
  if (typeof server.command !== "string") return
  const command = server.command.trim()
  if (!command) return
  if (command.includes("/") || command.startsWith(".")) return
  const found = which(command)
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
      const cmd = mcpEndpoint(server)
      console.log(`  - ${name}: ${cmd}`)
    }
  }
  console.log("")
}

function mcpEndpoint(server: McpServerDef | undefined): unknown {
  return server?.command ?? server?.serverUrl ?? server?.url ?? "(missing command)"
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
    console.log(`    transport: ${mcpEndpoint(server)}`)
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

async function validateMcpServers(
  parsed: ParsedManageArgs,
  base: string,
  which: (command: string) => string | null
): Promise<void> {
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
        validateAgentServer(agentId, name, server, localIssues)
        if (localIssues.length === 0) {
          validateServerBinary(name, server as McpServerDef, localIssues, which)
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

function validateServerHeaders(name: string, headers: unknown, issues: string[]): void {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    issues.push(`Server "${name}" has invalid headers (must be object of strings)`)
    return
  }
  for (const [headerKey, headerVal] of Object.entries(headers as Record<string, any>)) {
    if (typeof headerVal !== "string") {
      issues.push(`Server "${name}" header "${headerKey}" must be a string`)
    }
  }
}

function validateAgentRemoteServer(
  remoteKey: string,
  name: string,
  server: McpServerDef,
  issues: string[]
): void {
  const urlVal = server[remoteKey]
  if (typeof urlVal !== "string" || !URL.canParse(urlVal)) {
    issues.push(`Server "${name}" has an invalid ${remoteKey}`)
  }
  if (server.command !== undefined) {
    issues.push(`Server "${name}" must select one transport`)
  }
  if (server.headers !== undefined) {
    validateServerHeaders(name, server.headers, issues)
  }
}

function validateAgentServer(
  agentId: AgentId,
  name: string,
  server: McpServerDef,
  issues: string[]
): void {
  if (!server || typeof server !== "object") {
    validateServerShape(name, server, issues)
    return
  }
  const remoteKey = agentId === "antigravity" ? "serverUrl" : "url"
  if (Object.hasOwn(server, remoteKey)) {
    validateAgentRemoteServer(remoteKey, name, server, issues)
    return
  }
  const otherRemoteKey = agentId === "antigravity" ? "url" : "serverUrl"
  if (Object.hasOwn(server, otherRemoteKey)) {
    issues.push(`Server "${name}" has an invalid ${remoteKey}`)
    return
  }
  validateServerShape(name, server, issues)
}

export function translateServerForAgent(
  server: McpServerDef,
  targetAgentId: AgentId
): McpServerDef {
  const targetRemoteKey = targetAgentId === "antigravity" ? "serverUrl" : "url"
  if (
    server &&
    typeof server === "object" &&
    (Object.hasOwn(server, "url") || Object.hasOwn(server, "serverUrl"))
  ) {
    const endpointUrl = (server.serverUrl ?? server.url) as string
    const { url: _u, serverUrl: _su, ...rest } = server
    return {
      [targetRemoteKey]: endpointUrl,
      ...rest,
    } as McpServerDef
  }
  return server
}

async function readMergeSources(
  parsed: ParsedManageArgs,
  base: string
): Promise<Record<string, McpServerDef>> {
  const sourceIds = parsed.action === "sync" ? parsed.targetAgents : parsed.sourceAgents
  const convert =
    parsed.action === "sync" ||
    [...sourceIds, ...parsed.targetAgents].some((id) => id === "codex" || id === "antigravity")
  const sourceServers: Record<string, McpServerDef> = Object.create(null)
  for (const id of sourceIds) {
    const agent = getAgentConfig(id, parsed.project)
    const data = await readMcpFile(agent.resolvePath(base))
    const rawServers = data.mcpServers ?? {}
    for (const [name, server] of Object.entries(rawServers)) {
      const issues: string[] = []
      validateAgentServer(id, name, server, issues)
      if (issues.length > 0) {
        throw new Error(`${agent.displayName} (${agent.resolvePath(base)}): ${issues.join("; ")}`)
      }
    }
    const servers = convert ? portableServers(rawServers) : rawServers
    mergeSourceDefinitions(sourceServers, servers, parsed.action === "sync")
  }
  return sourceServers
}

function mergeSourceDefinitions(
  target: Record<string, McpServerDef>,
  source: Record<string, McpServerDef>,
  rejectConflicts: boolean
): void {
  for (const [name, server] of Object.entries(source)) {
    if (rejectConflicts && Object.hasOwn(target, name) && !mcpServersEqual(target[name]!, server)) {
      throw new Error(
        `Conflicting MCP server "${name}"; use merge --from <agent> to choose a definition before syncing`
      )
    }
    target[name] = server
  }
}

async function planAgentMerge(
  parsed: ParsedManageArgs,
  base: string,
  id: AgentId,
  sourceServers: Record<string, McpServerDef>
): Promise<{
  agent: AgentConfig
  path: string
  next: McpFileData
  addedCount: number
  updatedCount: number
}> {
  const agent = getAgentConfig(id, parsed.project)
  const path = agent.resolvePath(base)
  const data = await readMcpFile(path)
  const servers = { ...(data.mcpServers ?? {}) }
  let addedCount = 0
  let updatedCount = 0
  for (const [name, server] of Object.entries(sourceServers)) {
    const translated = translateServerForAgent(server, id)
    if (Object.hasOwn(servers, name) && mcpServersEqual(servers[name]!, translated)) continue
    if (Object.hasOwn(servers, name)) updatedCount++
    else addedCount++
    Object.defineProperty(servers, name, {
      value: translated,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  for (const [name, server] of Object.entries(servers)) {
    const issues: string[] = []
    validateAgentServer(id, name, server, issues)
    if (issues.length > 0) {
      throw new Error(`MCP validation failed for ${agent.displayName}: ${issues.join("; ")}`)
    }
  }
  const next = { ...data, mcpServers: servers }
  if (addedCount + updatedCount) renderMcpFile(path, next)
  return { agent, path, next, addedCount, updatedCount }
}

async function mergeMcpServers(parsed: ParsedManageArgs, base: string): Promise<void> {
  const sourceServers = await readMergeSources(parsed, base)
  const plans = []
  for (const id of parsed.targetAgents)
    plans.push(await planAgentMerge(parsed, base, id, sourceServers))
  for (const plan of plans) {
    if (plan.addedCount + plan.updatedCount > 0 && !parsed.dryRun)
      await writeMcpFile(plan.path, plan.next)
    console.log(
      `${parsed.dryRun ? "Would merge" : "Merged"} ${plan.addedCount} new and ${plan.updatedCount} updated servers into ${plan.agent.displayName} (${plan.path})`
    )
  }
}

async function resolveSyncTargets(
  parsed: ParsedManageArgs,
  base: string,
  detect: () => Promise<string[]>
): Promise<void> {
  if (parsed.explicitTargets) return
  const installed = new Set(await detect())
  const targets: AgentId[] = []
  for (const agent of agentList(parsed.project)) {
    if (installed.has(agent.id) || (await Bun.file(agent.resolvePath(base)).exists()))
      targets.push(agent.id)
  }
  parsed.targetAgents = targets
  if (!targets.length)
    throw new Error("No installed or configured MCP agents detected; select agent flags explicitly")
}

const SWIZ_MCP_SERVER_NAME = "swiz"
const SWIZ_MCP_SERVER_DEF: McpServerDef = { command: "swiz", args: ["mcp"] }

export function canonicalizeMcpServer(server: McpServerDef): McpServerDef {
  if (
    server &&
    typeof server === "object" &&
    (Object.hasOwn(server, "url") || Object.hasOwn(server, "serverUrl"))
  ) {
    const endpointUrl = (server.serverUrl ?? server.url) as string
    const { url: _u, serverUrl: _su, ...rest } = server
    return { url: endpointUrl, ...rest } as McpServerDef
  }
  if (server && typeof server === "object" && server.type === "stdio") {
    const { type: _type, ...rest } = server
    return rest as McpServerDef
  }
  return server
}

export function mcpServersEqual(a: McpServerDef, b: McpServerDef): boolean {
  if (isDeepStrictEqual(a, b)) return true
  return isDeepStrictEqual(canonicalizeMcpServer(a), canonicalizeMcpServer(b))
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

export interface ManageCommandOptions {
  cwd?: string
  home?: string
  which?: (command: string) => string | null
  detectAgents?: () => Promise<string[]>
}

async function runManageAction(
  parsed: ParsedManageArgs,
  base: string,
  which: (command: string) => string | null
): Promise<void> {
  const actions: Record<ManageAction, () => Promise<void>> = {
    list: () => listMcpServers(parsed.targetAgents, base, parsed.project),
    show: () => showMcpServer(parsed.targetAgents, base, parsed.project, parsed.name!),
    add: () => addMcpServer(parsed, base),
    remove: () => removeMcpServer(parsed, base),
    validate: () => validateMcpServers(parsed, base, which),
    merge: () => mergeMcpServers(parsed, base),
    sync: () => mergeMcpServers(parsed, base),
  }
  await actions[parsed.action]()
}

export const manageCommand: Command<ManageCommandOptions> = {
  name: "manage",
  description: "Manage shared swiz resources (MCP, etc.)",
  usage: "swiz manage mcp <list|show|add|remove|validate|merge|sync> [options]",
  options: [
    { flags: "mcp sync", description: "Union installed agents; conflicts fail before writes" },
    { flags: "--dry-run", description: "Preview sync or merge without writes" },
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
      flags: "--cursor --claude --claude-desktop --gemini --junie --ai --antigravity --agy --codex",
      description: "Limit action to selected agents",
    },
    {
      flags: "--from <agent|all>",
      description: "Specify source agent(s) for merge",
    },
    {
      flags: "--project",
      description:
        "Target project-level config files, including .agents/mcp_config.json and .codex/config.toml",
    },
  ],
  async run(args, options = {}) {
    const parsed = parseManageArgs(args)
    const home = options.home ?? getHomeDirOrNull()
    if (!home) throw new Error("HOME is not set; cannot manage MCP configuration.")

    // Project-scoped actions resolve paths relative to cwd; global actions use home.
    const base = parsed.project ? (options.cwd ?? process.cwd()) : home

    if (parsed.action === "sync") {
      await resolveSyncTargets(
        parsed,
        base,
        options.detectAgents ??
          (async () => (await detectInstalledAgents()).map((agent) => agent.id))
      )
    }
    await runManageAction(parsed, base, options.which ?? Bun.which)
  },
}
