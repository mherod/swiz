import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// Project-directory resolution for the `swiz mcp` stdio server.
//
// The Claude desktop app launches `swiz mcp` with cwd "/" and passes no project
// signal in the environment, so binding tools to process.cwd() pooled every
// desktop session's tasks into the single "-" project store (#955). The MCP
// handshake is the only per-session signal: a client that advertises the
// `roots` capability answers `roots/list` with its workspace directories.

export type McpCwdSource = "roots" | "process" | "unresolved"

export interface ResolvedMcpCwd {
  cwd: string | null
  source: McpCwdSource
}

/** The slice of the SDK low-level `Server` that root resolution needs. */
export interface McpRootsServer {
  getClientCapabilities(): { roots?: { listChanged?: boolean } } | undefined
  listRoots(): Promise<{ roots: ReadonlyArray<{ uri: string }> }>
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function firstRootDirectory(roots: ReadonlyArray<{ uri: string }>): Promise<string | null> {
  for (const root of roots) {
    if (!root.uri.startsWith("file://")) continue
    let path: string
    try {
      path = fileURLToPath(root.uri)
    } catch {
      continue
    }
    if (await isDirectory(path)) return path
  }
  return null
}

/**
 * Prefer the client's first `file://` root that is a directory. Keep the process
 * cwd only when it is a real project candidate, never the filesystem root: a "/"
 * cwd means the launcher gave no project, and resolving it would share one task
 * queue across every project again.
 */
export async function resolveMcpCwd(
  server: McpRootsServer,
  processCwd: string
): Promise<ResolvedMcpCwd> {
  if (server.getClientCapabilities()?.roots) {
    try {
      const cwd = await firstRootDirectory((await server.listRoots()).roots)
      if (cwd) return { cwd, source: "roots" }
    } catch {
      // A client that advertises roots but fails the request counts as having none.
    }
  }
  if (processCwd !== "/") return { cwd: processCwd, source: "process" }
  return { cwd: null, source: "unresolved" }
}

export interface McpCwdResolver {
  /** The latest resolution; resolves on first use when the handshake has not run it yet. */
  current(): Promise<ResolvedMcpCwd>
  /** Re-resolve, e.g. after `notifications/initialized` or `notifications/roots/list_changed`. */
  refresh(): Promise<ResolvedMcpCwd>
}

export function createMcpCwdResolver(server: McpRootsServer, processCwd: string): McpCwdResolver {
  let latest: Promise<ResolvedMcpCwd> | null = null
  const refresh = (): Promise<ResolvedMcpCwd> => {
    latest = resolveMcpCwd(server, processCwd)
    return latest
  }
  return { current: () => latest ?? refresh(), refresh }
}

/** Error text for task tools when no project directory could be resolved. */
export function unresolvedMcpCwdMessage(toolName: string): string {
  return (
    `${toolName} failed: swiz could not determine this session's project directory. ` +
    'The MCP client started `swiz mcp` with cwd "/", provided no file:// root, and no ' +
    "PreToolUse hook for this call reached the swiz daemon, so task tools are disabled rather " +
    "than writing to a queue shared by every project (swiz#955). " +
    "Restart the MCP server from the project directory, or use a client that supports MCP roots."
  )
}
