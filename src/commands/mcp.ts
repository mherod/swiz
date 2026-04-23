import { createHash } from "node:crypto"
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { getHomeDirWithFallback } from "../home.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { readTasks } from "../tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
  writeTaskUpdate,
} from "../tasks/task-service.ts"
import {
  swizMcpChannelHeartbeatPath,
  swizMcpChannelNotifyPath,
  swizMcpRepliesLogPath,
} from "../temp-paths.ts"
import type { Command } from "../types.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

// Run swiz as a Model Context Protocol (MCP) stdio server.
//
// Four-way channel: inbound auto-steers drain onto the session as
// <channel source="swiz"> events, outbound `reply` messages land in a JSONL
// sink, permission prompts are relayed through a policy file, and the drain
// loop wakes via fs.watch instead of tight polling.
//
// The SDK is loaded lazily via dynamic import — top-level imports measurably
// slowed every swiz CLI invocation.
//
// stdout is reserved for the JSON-RPC stream; human output goes to stderr.

const SERVER_NAME = "swiz"
const SERVER_VERSION = "0.2.0"

const INSTRUCTIONS = [
  'Events from swiz arrive as <channel source="swiz" trigger="..." session_id="...">.',
  'When trigger="next_turn" the content is an auto-steer: a directive from',
  "the swiz task system telling you what to do next (e.g. complete a",
  "specific task, push a commit, address a hook block). Read the content and",
  'act on it as if the user had just typed it. Triggers "after_commit" and',
  '"after_all_tasks_complete" forward post-action steers the same way.',
  "To send a message back through swiz (log, iMessage bridge, etc.) call the",
  '"reply" tool with { content, kind? }. No chat_id is required — swiz tags',
  "the entry with the project key automatically.",
].join(" ")

interface ChannelEvent {
  content: string
  meta?: Record<string, string>
}

/**
 * Generate a stable authentication token for this MCP session.
 * Includes server identity to prove this is from the official swiz server.
 */
function generateChannelAuthToken(projectKey: string, timestamp: number): string {
  const material = `${SERVER_NAME}:${SERVER_VERSION}:${projectKey}:${timestamp}`
  return createHash("sha256").update(material).digest("hex")
}

// Typed loosely because the SDK is only loaded at runtime via dynamic import
// and we don't want the type system to pull those modules at compile time
// from every call site that transitively reaches this file.
let activeServer: {
  server: { notification: (msg: { method: string; params: unknown }) => Promise<void> }
} | null = null

/**
 * Push a channel event into the connected Claude Code session.
 * Safe to call before the server is connected — the event is dropped and a
 * warning is written to stderr.
 */
export async function pushChannelEvent(event: ChannelEvent, projectKey: string): Promise<void> {
  if (activeServer === null) {
    process.stderr.write("swiz mcp: pushChannelEvent called before server was connected\n")
    return
  }
  const now = Date.now()
  const authToken = generateChannelAuthToken(projectKey, now)
  await activeServer.server.notification({
    method: "notifications/claude/channel",
    params: {
      content: event.content,
      channel: {
        uri: `mcp://swiz/${projectKey}`,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        auth_token: authToken,
        timestamp: now,
      },
      meta: event.meta ?? {},
    },
  })
}

// ─── Auto-steer drain loop ──────────────────────────────────────────────────

// Safety fallback only — the fast path is fs.watch on the notify sentinel.
// Keep this loose so we don't hammer SQLite when nothing is enqueued.
const AUTO_STEER_POLL_INTERVAL_MS = 5_000

// Triggers delivered via the MCP channel. `on_session_stop` stays on the
// AppleScript path because by the time stop fires, the MCP transport is
// tearing down alongside the agent session.
const CHANNEL_TRIGGERS = ["next_turn", "after_commit", "after_all_tasks_complete"] as const

async function drainAutoSteersOnce(projectKey: string): Promise<void> {
  if (activeServer === null) return
  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  for (const trigger of CHANNEL_TRIGGERS) {
    while (true) {
      const req = store.consumeOneByProjectKey(projectKey, trigger)
      if (!req) break
      try {
        await pushChannelEvent(
          {
            content: req.message,
            meta: {
              trigger: req.trigger,
              session_id: req.sessionId,
              created_at: String(req.createdAt),
            },
          },
          projectKey
        )
      } catch (err) {
        const message = messageFromUnknownError(err)
        process.stderr.write(`swiz mcp: failed to push auto-steer event: ${message}\n`)
        // Don't re-enqueue: the row is marked delivered. Move on.
        return
      }
    }
  }
}

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

/**
 * Ensure the notify sentinel exists so `fs.watch` can bind to it. The path
 * must exist at watch time; we also recreate it if a consumer unlinks it.
 */
function ensureNotifyFile(projectKey: string): string {
  const path = swizMcpChannelNotifyPath(projectKey)
  try {
    writeFileSync(path, "", { flag: "a" })
  } catch {
    // best-effort; watch may fall back to poll
  }
  return path
}

function startAutoSteerDrainLoop(cwd: string): () => void {
  const projectKey = projectKeyFromCwd(cwd)
  let stopped = false
  let draining = false
  let pending = false

  refreshChannelHeartbeat(projectKey)

  const drain = async (): Promise<void> => {
    if (stopped) return
    if (draining) {
      pending = true
      return
    }
    draining = true
    try {
      refreshChannelHeartbeat(projectKey)
      await drainAutoSteersOnce(projectKey)
    } catch (err) {
      const message = messageFromUnknownError(err)
      process.stderr.write(`swiz mcp: auto-steer drain error: ${message}\n`)
    } finally {
      draining = false
      if (pending && !stopped) {
        pending = false
        void drain()
      }
    }
  }

  // Fast path: watch the notify sentinel for any mtime bump.
  const notifyPath = ensureNotifyFile(projectKey)
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(notifyPath, { persistent: false }, () => void drain())
    watcher.on("error", (err) => {
      process.stderr.write(`swiz mcp: notify watch error: ${String(err)}\n`)
    })
  } catch (err) {
    process.stderr.write(`swiz mcp: notify watch failed to start: ${String(err)}\n`)
  }

  // Safety fallback poll — catches any missed notify (rename, nfs, etc.).
  const timer = setInterval(() => void drain(), AUTO_STEER_POLL_INTERVAL_MS)
  timer.unref?.()

  // Kick once at startup so any messages queued before we connected are flushed.
  void drain()

  return () => {
    stopped = true
    clearInterval(timer)
    try {
      watcher?.close()
    } catch {
      // watcher already closed
    }
    clearChannelHeartbeat(projectKey)
  }
}

// ─── Permission relay ───────────────────────────────────────────────────────

interface PermissionRule {
  tool: string
  pattern?: string
  behavior: "allow" | "deny"
}

const PermissionPolicySchema = z.object({
  rules: z.array(
    z.object({
      tool: z.string(),
      pattern: z.string().optional(),
      behavior: z.enum(["allow", "deny"]),
    })
  ),
})

function loadPermissionPolicy(cwd: string): PermissionRule[] {
  const path = `${cwd}/.swiz/permission-policy.json`
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = PermissionPolicySchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      process.stderr.write(`swiz mcp: permission-policy.json invalid — ${parsed.error.message}\n`)
      return []
    }
    return parsed.data.rules
  } catch {
    return []
  }
}

function evaluatePermissionPolicy(
  rules: PermissionRule[],
  toolName: string,
  inputPreview: string
): "allow" | "deny" | null {
  for (const rule of rules) {
    if (rule.tool !== toolName && rule.tool !== "*") continue
    if (rule.pattern) {
      try {
        const re = new RegExp(rule.pattern)
        if (!re.test(inputPreview)) continue
      } catch {
        continue
      }
    }
    return rule.behavior
  }
  return null
}

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

type McpLowLevelServer = {
  notification: (msg: { method: string; params: unknown }) => Promise<void>
  setNotificationHandler: (
    schema: unknown,
    handler: (req: {
      params: { request_id: string; tool_name: string; input_preview: string }
    }) => Promise<void>
  ) => void
}

function registerPermissionRelay(lowLevel: McpLowLevelServer, cwd: string): void {
  lowLevel.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const rules = loadPermissionPolicy(cwd)
    const verdict = evaluatePermissionPolicy(rules, params.tool_name, params.input_preview)
    if (verdict === null) {
      process.stderr.write(
        `swiz mcp: permission ${params.request_id} ${params.tool_name} — no matching rule, deferring to local dialog\n`
      )
      return
    }
    process.stderr.write(
      `swiz mcp: permission ${params.request_id} ${params.tool_name} → ${verdict}\n`
    )
    try {
      await lowLevel.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: params.request_id, behavior: verdict },
      })
    } catch (err) {
      const message = messageFromUnknownError(err)
      process.stderr.write(`swiz mcp: failed to emit permission verdict: ${message}\n`)
    }
  })
}

// ─── Reply tool sink ────────────────────────────────────────────────────────

function appendReplyToSink(cwd: string, payload: { content: string; kind: string }): void {
  const home = getHomeDirWithFallback("/tmp")
  const path = swizMcpRepliesLogPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const row = `${JSON.stringify({
    ts: Date.now(),
    project_key: projectKeyFromCwd(cwd),
    cwd,
    kind: payload.kind,
    content: payload.content,
  })}\n`
  appendFileSync(path, row)
}

// ─── Server entry point ─────────────────────────────────────────────────────

async function serve(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

  const cwd = process.cwd()

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  )

  server.registerTool(
    "reply",
    {
      title: "Reply through swiz",
      description:
        "Send a message back through the swiz channel. Appends to ~/.swiz/mcp-replies.jsonl. " +
        'Use `kind` to mark the intent (e.g. "note", "status", "imessage").',
      inputSchema: {
        content: z.string().describe("Message body"),
        kind: z.string().optional().describe('Reply kind, e.g. "note" or "status"'),
      },
    },
    async ({ content, kind }) => {
      try {
        appendReplyToSink(cwd, { content, kind: kind ?? "note" })
      } catch (err) {
        const message = messageFromUnknownError(err)
        return {
          content: [{ type: "text" as const, text: `reply failed: ${message}` }],
          isError: true,
        }
      }
      return { content: [{ type: "text" as const, text: "ok" }] }
    }
  )

  server.registerTool(
    "TaskCreate",
    {
      title: "Create a task",
      description:
        "Create a new task in the current session. Returns the created task with its ID. " +
        "Tasks must have a non-compound subject (one verb/action per task). " +
        "Description should briefly explain what the task entails.",
      inputSchema: {
        subject: z.string().describe("Task subject in imperative form (e.g., 'Fix login bug')"),
        description: z.string().describe("Detailed description of what the task requires"),
        activeForm: z
          .string()
          .optional()
          .describe("Present continuous form for spinner display (e.g., 'Fixing login bug')"),
      },
    },
    async ({ subject, description, activeForm }) => {
      try {
        const projectKey = projectKeyFromCwd(cwd)
        const task = await createTaskInProcess({
          sessionId: projectKey,
          subject,
          description,
          cwd,
        })
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                task: {
                  id: task.id,
                  subject: task.subject,
                  description: task.description,
                  activeForm: activeForm || undefined,
                  status: task.status,
                },
              }),
            },
          ],
        }
      } catch (err) {
        const message = messageFromUnknownError(err)
        return {
          content: [{ type: "text" as const, text: `TaskCreate failed: ${message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "TaskUpdate",
    {
      title: "Update a task",
      description:
        "Update an existing task's status, subject, description, or dependencies. " +
        "Status transitions: pending → in_progress → completed. " +
        "Can also add/remove task blocking relationships.",
      inputSchema: {
        taskId: z.string().describe("Task ID to update (e.g., 'S1234-1')"),
        status: z
          .enum(["pending", "in_progress", "completed", "cancelled"])
          .optional()
          .describe("New task status"),
        subject: z.string().optional().describe("Updated task subject"),
        description: z.string().optional().describe("Updated task description"),
        addBlocks: z
          .array(z.string())
          .optional()
          .describe("List of task IDs this task should block"),
        addBlockedBy: z
          .array(z.string())
          .optional()
          .describe("List of task IDs that should block this task"),
      },
    },
    async ({ taskId, status, subject, description, addBlocks, addBlockedBy }) => {
      try {
        const projectKey = projectKeyFromCwd(cwd)
        const allTasks = await readTasks(projectKey)
        const task = allTasks.find((t) => t.id === taskId)
        if (!task) {
          return {
            content: [
              { type: "text" as const, text: `TaskUpdate failed: task ${taskId} not found` },
            ],
            isError: true,
          }
        }

        // Update field values
        if (subject !== undefined) task.subject = subject
        if (description !== undefined) task.description = description
        if (addBlocks) {
          task.blocks = [...new Set([...task.blocks, ...addBlocks])]
        }
        if (addBlockedBy) {
          task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])]
        }

        // Update status
        if (status !== undefined && status !== task.status) {
          if (status === "completed") {
            await completeTaskWithAutoTransition(projectKey, taskId, { filterCwd: cwd })
          } else {
            await updateStatus(projectKey, taskId, status, { filterCwd: cwd })
          }
        } else if (
          subject !== undefined ||
          description !== undefined ||
          addBlocks ||
          addBlockedBy
        ) {
          // Field update without status change
          await writeTaskUpdate(projectKey, taskId, task)
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                task: {
                  id: task.id,
                  subject: task.subject,
                  description: task.description,
                  status: task.status,
                  blocks: task.blocks,
                  blockedBy: task.blockedBy,
                },
              }),
            },
          ],
        }
      } catch (err) {
        const message = messageFromUnknownError(err)
        return {
          content: [{ type: "text" as const, text: `TaskUpdate failed: ${message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "TaskList",
    {
      title: "List all tasks",
      description:
        "Retrieve all tasks in the current session. Returns task metadata including " +
        "IDs, subjects, statuses, and blocking relationships. Useful for understanding " +
        "the current task state without native tool support.",
      inputSchema: {
        // No required input parameters
      },
    },
    async () => {
      try {
        const projectKey = projectKeyFromCwd(cwd)
        const allTasks = await readTasks(projectKey)

        const tasks = allTasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          description: t.description,
          status: t.status,
          blocks: t.blocks,
          blockedBy: t.blockedBy,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
          elapsedMs: t.elapsedMs,
        }))

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                tasks,
                summary: {
                  total: allTasks.length,
                  pending: allTasks.filter((t) => t.status === "pending").length,
                  inProgress: allTasks.filter((t) => t.status === "in_progress").length,
                  completed: allTasks.filter((t) => t.status === "completed").length,
                },
              }),
            },
          ],
        }
      } catch (err) {
        const message = messageFromUnknownError(err)
        return {
          content: [{ type: "text" as const, text: `TaskList failed: ${message}` }],
          isError: true,
        }
      }
    }
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  activeServer = server as unknown as typeof activeServer

  const lowLevel = (server as unknown as { server: McpLowLevelServer }).server
  try {
    registerPermissionRelay(lowLevel, cwd)
  } catch (err) {
    process.stderr.write(`swiz mcp: failed to register permission relay: ${String(err)}\n`)
  }

  process.stderr.write(
    `swiz mcp server ready (${SERVER_NAME} ${SERVER_VERSION}) — channel + permission + reply + task-tools enabled\n`
  )

  const stopDrain = startAutoSteerDrainLoop(cwd)
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
