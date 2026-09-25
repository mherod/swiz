import { MCP_TOOL_NAMES, type McpToolInput, type McpToolName } from "./mcp-tool-core.ts"

// Caller-directory correlation for MCP tool calls that reach the daemon from cwd "/".
//
// The Claude desktop app launches `swiz mcp` with cwd "/", and a stdio server that
// cannot resolve MCP roots (or predates root resolution) forwards "/" to the daemon.
// Claude Code dispatches a PreToolUse hook for the same call first, carrying the
// session's real cwd, and both reach this daemon. Recording the hook and claiming it
// when the tool call arrives recovers the caller's project instead of writing to the
// "-" store every desktop session shares (#955).

/** How long a recorded PreToolUse stays claimable; covers a permission prompt in between. */
export const MCP_CALLER_WINDOW_MS = 5 * 60 * 1000

const MCP_TOOL_SET: ReadonlySet<string> = new Set(MCP_TOOL_NAMES)

/** `mcp__<server>__<tool>` → the swiz MCP tool name, or null for any other tool or server. */
export function swizMcpToolFromHookName(toolName: string): McpToolName | null {
  const match = /^mcp__(.+)__([A-Za-z]+)$/.exec(toolName)
  if (!match || !match[1]!.includes("swiz") || !MCP_TOOL_SET.has(match[2]!)) return null
  return match[2] as McpToolName
}

/** Order-independent key for a tool input: the hook and the MCP call carry the same arguments. */
export function mcpInputKey(input: McpToolInput | undefined): string {
  // JSON.stringify drops undefined members; the replacer sorts object keys at every depth.
  return JSON.stringify(input ?? {}, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )
}

interface PendingMcpCall {
  tool: McpToolName
  inputKey: string
  cwd: string
  at: number
}

export class McpCallerCwdRegistry {
  private pending: PendingMcpCall[] = []

  constructor(private readonly windowMs = MCP_CALLER_WINDOW_MS) {}

  /** Record a PreToolUse for a swiz MCP tool; other tools and rootless cwds are ignored. */
  record(
    hookToolName: string,
    toolInput: McpToolInput | undefined,
    cwd: string | null | undefined,
    now: number
  ): void {
    const tool = swizMcpToolFromHookName(hookToolName)
    if (!tool || !cwd || cwd === "/") return
    this.prune(now)
    this.pending.push({ tool, inputKey: mcpInputKey(toolInput), cwd, at: now })
  }

  /**
   * Claim the oldest unclaimed recording for this call. Each PreToolUse precedes exactly one
   * tool call, so first-in-first-out pairs concurrent identical calls in arrival order.
   */
  claim(tool: McpToolName, input: McpToolInput | undefined, now: number): string | null {
    this.prune(now)
    const inputKey = mcpInputKey(input)
    const index = this.pending.findIndex((call) => call.tool === tool && call.inputKey === inputKey)
    if (index === -1) return null
    const [claimed] = this.pending.splice(index, 1)
    return claimed!.cwd
  }

  private prune(now: number): void {
    this.pending = this.pending.filter((call) => now - call.at <= this.windowMs)
  }
}

/** Daemon-wide registry shared by the dispatch capture and the MCP tool route. */
export const mcpCallerCwdRegistry = new McpCallerCwdRegistry()
