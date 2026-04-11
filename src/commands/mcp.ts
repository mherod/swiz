import { unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { projectKeyFromCwd } from "../project-key.ts"
import { swizMcpChannelHeartbeatPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"

// Run swiz as a Model Context Protocol (MCP) stdio server.
//
// This is the foundation layer for Swiz → agent-session push. We use
// McpServer from the official SDK and declare the `claude/channel`
// experimental capability so Claude Code registers a listener and we can
// push `<channel source="swiz" ...>` events into a running session via
// `pushChannelEvent()`. For now a single no-op tool is registered; more
// producers (auto-steers, CI watcher, issue sync) will wire into
// `pushChannelEvent` without touching the transport layer.
//
// IMPORTANT: the SDK is loaded lazily via dynamic import. The command module
// is eagerly imported by `index.ts` for command registration, and pulling in
// `@modelcontextprotocol/sdk` at the top level measurably slows every swiz
// CLI invocation (enough to time out CLI subprocess tests). Dynamic import
// defers the cost to the single invocation that actually runs the server.
//
// stdout is reserved for the JSON-RPC stream (the stdio transport writes to
// it). Any human-facing output must go to stderr.

const SERVER_NAME = "swiz"
const SERVER_VERSION = "0.1.0"

const INSTRUCTIONS = [
  'Events from swiz arrive as <channel source="swiz" trigger="..." session_id="...">.',
  'When trigger="next_turn" the content is an auto-steer: a directive from',
  "the swiz task system telling you what to do next (e.g. complete a",
  "specific task, push a commit, address a hook block). Read the content and",
  "act on it as if the user had just typed it. Other triggers forward CI",
  "results, issue activity, and push completions. No reply is expected.",
].join(" ")

interface ChannelEvent {
  content: string
  meta?: Record<string, string>
}

// The active server, captured once connected. Typed loosely because the SDK
// is only loaded at runtime via dynamic import and we don't want the type
// system to pull those modules at compile time from every call site that
// transitively reaches this file.
let activeServer: {
  server: { notification: (msg: { method: string; params: unknown }) => Promise<void> }
} | null = null

/**
 * Push a channel event into the connected Claude Code session.
 * Safe to call before the server is connected — the event is dropped and a
 * warning is written to stderr.
 */
export async function pushChannelEvent(event: ChannelEvent): Promise<void> {
  if (activeServer === null) {
    process.stderr.write("swiz mcp: pushChannelEvent called before server was connected\n")
    return
  }
  await activeServer.server.notification({
    method: "notifications/claude/channel",
    params: { content: event.content, meta: event.meta ?? {} },
  })
}

// How often the auto-steer drain loop checks the SQLite queue while the MCP
// server is connected. 500ms keeps latency low for `next_turn` steers without
// hammering the DB (reads are WAL-backed and cheap).
const AUTO_STEER_POLL_INTERVAL_MS = 500

async function drainAutoSteersOnce(projectKey: string): Promise<void> {
  if (activeServer === null) return
  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  // Only `next_turn` is delivered via the channel path. `after_commit` and
  // `after_all_tasks_complete` require tool-event context that only the
  // PostToolUse hook sees, and `on_session_stop` fires during stop teardown.
  // They stay on the existing AppleScript path.
  while (true) {
    const req = store.consumeOneByProjectKey(projectKey, "next_turn")
    if (!req) break
    try {
      await pushChannelEvent({
        content: req.message,
        meta: {
          trigger: req.trigger,
          session_id: req.sessionId,
          created_at: String(req.createdAt),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`swiz mcp: failed to push auto-steer event: ${message}\n`)
      // Don't re-enqueue: the message has already been marked delivered, and
      // requeueing would race with the AppleScript path. Surface the error
      // and move on.
      break
    }
  }
}

/**
 * Touch the heartbeat sentinel for this project so PostToolUse auto-steer
 * knows the MCP channel is live and should own `next_turn` delivery.
 * Creating the file on first call ensures the sentinel exists even when the
 * drain loop runs before any other producer writes it.
 */
function refreshChannelHeartbeat(projectKey: string): void {
  const path = swizMcpChannelHeartbeatPath(projectKey)
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    try {
      writeFileSync(path, "")
    } catch {
      // heartbeat is advisory; swallow to keep the drain loop alive
    }
  }
}

function clearChannelHeartbeat(projectKey: string): void {
  try {
    unlinkSync(swizMcpChannelHeartbeatPath(projectKey))
  } catch {
    // already gone; nothing to do
  }
}

function startAutoSteerDrainLoop(cwd: string): () => void {
  const projectKey = projectKeyFromCwd(cwd)
  let stopped = false
  refreshChannelHeartbeat(projectKey)
  const tick = async (): Promise<void> => {
    if (stopped) return
    refreshChannelHeartbeat(projectKey)
    try {
      await drainAutoSteersOnce(projectKey)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`swiz mcp: auto-steer drain error: ${message}\n`)
    }
  }
  const timer = setInterval(() => void tick(), AUTO_STEER_POLL_INTERVAL_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
    clearChannelHeartbeat(projectKey)
  }
}

async function serve(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  )

  server.registerTool(
    "noop",
    {
      title: "No-op",
      description:
        "No-op tool. Returns a fixed acknowledgement — useful for verifying the swiz MCP server is reachable.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: "ok" }],
    })
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  activeServer = server as unknown as typeof activeServer
  process.stderr.write(
    `swiz mcp server ready (${SERVER_NAME} ${SERVER_VERSION}) — channel capability enabled\n`
  )

  const stopDrain = startAutoSteerDrainLoop(process.cwd())
  const cleanup = (): void => {
    stopDrain()
    activeServer = null
  }
  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)
  process.once("beforeExit", cleanup)
}

export const mcpCommand: Command = {
  name: "mcp",
  description: "Run swiz as a Model Context Protocol (MCP) stdio server (with channel support)",
  usage: "swiz mcp",
  async run() {
    await serve()
  },
}
