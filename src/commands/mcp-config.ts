import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { stripTomlRoot } from "../utils/toml.ts"
import { writeWithBackup } from "./install/file-helpers.ts"

export interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
  [key: string]: unknown
}

const originalText = Symbol("original MCP configuration")
export interface McpFileData {
  mcpServers?: Record<string, McpServerDef>
  [originalText]?: string
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export async function readMcpFile(path: string): Promise<McpFileData> {
  const file = Bun.file(path)
  const text = (await file.exists()) ? await file.text() : ""
  let data: unknown
  try {
    data = text ? (path.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text)) : {}
  } catch {
    throw new Error(`Invalid MCP configuration in ${path}`)
  }
  if (!isRecord(data)) throw new Error(`Invalid MCP configuration object in ${path}`)
  const servers = path.endsWith(".toml") ? data.mcp_servers : data.mcpServers
  if (servers !== undefined && !isRecord(servers)) {
    throw new Error(`Invalid MCP server map in ${path}`)
  }
  return { ...data, mcpServers: servers as McpFileData["mcpServers"], [originalText]: text }
}

/** Emit only JSON-compatible MCP values; Bun reparses the complete document before writing. */
function tomlValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{ ${Object.entries(value)
      .map(([key, val]) => `${JSON.stringify(key)} = ${tomlValue(val)}`)
      .join(", ")} }`
  }
  throw new Error("Unsupported MCP value for TOML; configuration was not written")
}

export function renderMcpFile(path: string, value: McpFileData): string {
  if (!path.endsWith(".toml")) return `${JSON.stringify(value, null, 2)}\n`
  try {
    return renderCodexMcp(value)
  } catch {
    throw new Error("Cannot safely update Codex MCP configuration; no settings were written")
  }
}

function renderCodexMcp(value: McpFileData): string {
  const original = value[originalText] ?? ""
  const before = Bun.TOML.parse(original)
  const kept = stripTomlRoot(original, "mcp_servers")
  const servers = value.mcpServers ?? {}
  const tables = Object.entries(servers).map(
    ([name, server]) =>
      `[mcp_servers.${JSON.stringify(name)}]\n${Object.entries(server)
        .map(([key, val]) => `${JSON.stringify(key)} = ${tomlValue(val)}`)
        .join("\n")}`
  )
  const result = `${kept.trimEnd()}\n\n${tables.join("\n\n")}\n`
  const expected: Record<string, unknown> = { ...before }
  delete expected.mcp_servers
  if (tables.length) expected.mcp_servers = servers
  if (!isDeepStrictEqual(Bun.TOML.parse(result), expected)) {
    throw new Error("Cannot safely update Codex MCP configuration; no settings were written")
  }
  return result
}

export async function writeMcpFile(path: string, value: McpFileData): Promise<void> {
  const text = renderMcpFile(path, value)
  if (value[originalText] !== undefined) {
    const current = (await Bun.file(path).exists()) ? await Bun.file(path).text() : ""
    if (current !== value[originalText]) {
      throw new Error(`MCP configuration changed during operation: ${path}; retry`)
    }
  }
  await mkdir(dirname(path), { recursive: true })
  await writeWithBackup(path, text)
}

export function assertPortableServers(servers: Record<string, McpServerDef>): void {
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server) || typeof server.command !== "string" || !server.command.trim()) {
      throw new Error(
        `Server "${name}" is not a portable stdio definition; configure its transport separately`
      )
    }
    const allowed = new Set(["command", "args", "env", "type"])
    if (
      Object.keys(server).some((key) => !allowed.has(key)) ||
      (server.type !== undefined && server.type !== "stdio")
    ) {
      throw new Error(
        `Server "${name}" has agent-specific fields; configure it separately before syncing`
      )
    }
    assertPortableOptions(name, server)
  }
}

function assertPortableOptions(name: string, server: McpServerDef): void {
  if (
    server.args !== undefined &&
    (!Array.isArray(server.args) || server.args.some((a) => typeof a !== "string"))
  ) {
    throw new Error(`Server "${name}" has invalid args`)
  }
  if (
    server.env !== undefined &&
    (!isRecord(server.env) || Object.values(server.env).some((v) => typeof v !== "string"))
  ) {
    throw new Error(`Server "${name}" has invalid env`)
  }
}

export function portableServers(
  servers: Record<string, McpServerDef>
): Record<string, McpServerDef> {
  assertPortableServers(servers)
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const { type: _type, ...portable } = server
      return [name, portable]
    })
  )
}
