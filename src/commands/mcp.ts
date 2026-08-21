import { createHash } from "node:crypto"
import { readFileSync, unlinkSync, utimesSync, watch, writeFileSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { CHANNEL_DELIVERABLE_TRIGGERS } from "../auto-steer-store.ts"
import { getHomeDirWithFallback } from "../home.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { readSwizSettings } from "../settings.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { getTaskToolName } from "../tasks/task-governance-messages.ts"
import {
  describeTaskChanges,
  findNewlyUnblockedTasks,
  MAX_LISTED_PER_GROUP,
  renderTaskToolResult,
  renderUnblockedLine,
  summarizeTasks,
  type TaskListSummary,
  truncateForLine,
} from "../tasks/task-mcp-view.ts"
import { pruneStaleCompletedTasks } from "../tasks/task-prune.ts"
import { isSafeSessionId, readTasks, type Task } from "../tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
  writeTaskUpdate,
} from "../tasks/task-service.ts"
import {
  SWIZ_MCP_CHANNEL_DRAIN_INTERVAL_MS,
  swizMcpChannelHeartbeatPath,
  swizMcpChannelNotifyPath,
  swizMcpChannelStatusPath,
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

const CHANNEL_INSTRUCTIONS = [
  'Events from swiz arrive as <channel source="swiz" trigger="..." session_id="...">.',
  'When trigger="next_turn" the content is an auto-steer: a directive from',
  "the swiz task system telling you what to do next (e.g. complete a",
  "specific task, push a commit, address a hook block). Read the content and",
  'act on it as if the user had just typed it. Triggers "after_commit" and',
  '"after_all_tasks_complete" forward post-action steers the same way.',
]

const BASE_INSTRUCTIONS = [
  "To send a message back through swiz (log, iMessage bridge, etc.) call the",
  '"reply" tool with { content, kind? }. No chat_id is required — swiz tags',
  "the entry with the project key automatically.",
]

export function buildMcpInstructions(mcpChannels: boolean): string {
  return [...(mcpChannels ? CHANNEL_INSTRUCTIONS : []), ...BASE_INSTRUCTIONS].join(" ")
}

type McpServerCapabilities = {
  experimental?: Record<string, Record<string, never>>
  tools: Record<string, never>
}

export function buildMcpCapabilities(mcpChannels: boolean): McpServerCapabilities {
  const capabilities: McpServerCapabilities = { tools: {} }
  if (mcpChannels) {
    capabilities.experimental = {
      "claude/channel": {},
      "claude/channel/permission": {},
    }
  }
  return capabilities
}

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
// Channel-deliverable triggers are defined centrally in auto-steer-store.ts.

interface McpChannelRuntimeStatus {
  projectKey: string
  cwd: string
  pid: number
  serverName: string
  serverVersion: string
  connected: boolean
  watcherState: "starting" | "active" | "error" | "unavailable" | "closed"
  startedAt: number
  updatedAt: number
  lastDrainStartedAt?: number
  lastDrainCompletedAt?: number
  lastDrainError?: string
  deliveredCount: number
}

function writeChannelStatus(status: McpChannelRuntimeStatus): void {
  const updated = { ...status, updatedAt: Date.now() }
  try {
    writeFileSync(swizMcpChannelStatusPath(status.projectKey), `${JSON.stringify(updated)}\n`)
  } catch {
    // status is diagnostic only; keep the MCP transport alive
  }
}

async function drainAutoSteersOnce(projectKey: string): Promise<number> {
  if (activeServer === null) return 0
  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const { renderQueuedAutoSteerRequest } = await import("../utils/auto-steer-helpers.ts")
  const store = getAutoSteerStore()
  let delivered = 0
  for (const trigger of CHANNEL_DELIVERABLE_TRIGGERS) {
    while (true) {
      const req = store.consumeOneByProjectKey(projectKey, trigger)
      if (!req) break
      try {
        const message = await renderQueuedAutoSteerRequest(req.sessionId, req)
        await pushChannelEvent(
          {
            content: message,
            meta: {
              trigger: req.trigger,
              session_id: req.sessionId,
              created_at: String(req.createdAt),
            },
          },
          projectKey
        )
        delivered += 1
      } catch (err) {
        const message = messageFromUnknownError(err)
        process.stderr.write(`swiz mcp: failed to push auto-steer event: ${message}\n`)
        // Don't re-enqueue: the row is marked delivered. Move on.
        return delivered
      }
    }
  }
  return delivered
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
  const startedAt = Date.now()
  const status: McpChannelRuntimeStatus = {
    projectKey,
    cwd,
    pid: process.pid,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    connected: activeServer !== null,
    watcherState: "starting",
    startedAt,
    updatedAt: startedAt,
    deliveredCount: 0,
  }

  refreshChannelHeartbeat(projectKey)
  writeChannelStatus(status)

  const drain = async (): Promise<void> => {
    if (stopped) return
    if (draining) {
      pending = true
      return
    }
    draining = true
    try {
      refreshChannelHeartbeat(projectKey)
      status.connected = activeServer !== null
      status.lastDrainStartedAt = Date.now()
      status.lastDrainError = undefined
      writeChannelStatus(status)
      status.deliveredCount += await drainAutoSteersOnce(projectKey)
      status.lastDrainCompletedAt = Date.now()
      writeChannelStatus(status)
    } catch (err) {
      const message = messageFromUnknownError(err)
      status.lastDrainError = message
      writeChannelStatus(status)
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
    status.watcherState = "active"
    writeChannelStatus(status)
    watcher.on("error", (err) => {
      status.watcherState = "error"
      status.lastDrainError = String(err)
      writeChannelStatus(status)
      process.stderr.write(`swiz mcp: notify watch error: ${String(err)}\n`)
    })
  } catch (err) {
    status.watcherState = "unavailable"
    status.lastDrainError = String(err)
    writeChannelStatus(status)
    process.stderr.write(`swiz mcp: notify watch failed to start: ${String(err)}\n`)
  }

  // Safety fallback poll — catches any missed notify (rename, nfs, etc.).
  const timer = setInterval(() => void drain(), SWIZ_MCP_CHANNEL_DRAIN_INTERVAL_MS)
  timer.unref?.()

  // Kick once at startup so any messages queued before we connected are flushed.
  void drain()

  return () => {
    stopped = true
    status.connected = false
    status.watcherState = "closed"
    writeChannelStatus(status)
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

interface CompiledPermissionRule extends PermissionRule {
  patternRegex?: RegExp
}

const MAX_PERMISSION_PATTERN_LENGTH = 200

const INVALID_PATTERN_HINT =
  "permission-policy.json contains potentially unsafe regex patterns — unsupported constructs were rejected"

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (text[cursor] !== "\\") break
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function skipCharClass(text: string, start: number): number {
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === "]" && !isEscaped(text, index)) {
      return index
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1
    }
    index += 1
  }
  return index
}

function isQuantifierCharacter(char: string | undefined): boolean {
  return char === "*" || char === "+" || char === "?" || char === "{"
}

function hasQuantifier(text: string): boolean {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "[" && !isEscaped(text, index)) {
      index = skipCharClass(text, index + 1)
      continue
    }
    if (isQuantifierCharacter(char) && !isEscaped(text, index)) {
      return true
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1
    }
    index += 1
  }
  return false
}

function quantifiedGroupBody(pattern: string, start: number, closeIndex: number): string | null {
  let lookahead = closeIndex + 1
  while (/\s/.test(pattern[lookahead] ?? "")) lookahead += 1
  return isQuantifierCharacter(pattern[lookahead]) ? pattern.slice(start + 1, closeIndex) : null
}

function hasUnsafeNestedQuantifier(pattern: string): boolean {
  const stack: number[] = []
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index]

    if (char === "\\" && index + 1 < pattern.length) {
      index += 2
      continue
    }

    if (char === "[") {
      index = skipCharClass(pattern, index + 1) + 1
      continue
    }

    if (char === "(") {
      stack.push(index)
      index += 1
      continue
    }

    if (char === ")") {
      const start = stack.pop()
      const body = start === undefined ? null : quantifiedGroupBody(pattern, start, index)
      if (body !== null && hasQuantifier(body)) return true
      index += 1
      continue
    }

    index += 1
  }

  return false
}

function validatePermissionPattern(pattern: string): boolean {
  if (pattern.length === 0) return false
  if (pattern.length > MAX_PERMISSION_PATTERN_LENGTH) return false
  if (hasUnsafeNestedQuantifier(pattern)) return false
  return true
}

function getErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null
  const code = (err as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

const PermissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().max(MAX_PERMISSION_PATTERN_LENGTH).optional(),
  behavior: z.enum(["allow", "deny"]),
})

const PermissionPolicySchema = z.object({
  rules: z.array(PermissionRuleSchema),
})

function loadPermissionPolicy(cwd: string): CompiledPermissionRule[] {
  const path = `${cwd}/.swiz/permission-policy.json`
  try {
    const raw = readFileSync(path, "utf8")
    let rawRules: unknown
    try {
      rawRules = JSON.parse(raw)
    } catch (err) {
      const message = messageFromUnknownError(err)
      process.stderr.write(
        `swiz mcp: failed to parse permission-policy.json at ${path}: ${message}\n`
      )
      return []
    }
    const parsed = PermissionPolicySchema.safeParse(rawRules)
    if (!parsed.success) {
      process.stderr.write(
        `swiz mcp: permission-policy.json schema invalid at ${path}: ${parsed.error.message}\n`
      )
      return []
    }

    const compiled: CompiledPermissionRule[] = []
    for (const rule of parsed.data.rules) {
      if (!rule.pattern) {
        compiled.push(rule)
        continue
      }
      if (!validatePermissionPattern(rule.pattern)) {
        process.stderr.write(
          `swiz mcp: permission-policy.json at ${path} skipped unsafe pattern "${rule.pattern}" in rule for ${rule.tool} — ${INVALID_PATTERN_HINT}\n`
        )
        continue
      }
      try {
        compiled.push({
          ...rule,
          patternRegex: new RegExp(rule.pattern),
        })
      } catch (err) {
        process.stderr.write(
          `swiz mcp: permission-policy.json at ${path} skipped unsafe pattern "${rule.pattern}" in rule for ${rule.tool} — ${INVALID_PATTERN_HINT}: ${messageFromUnknownError(err)}\n`
        )
      }
    }
    return compiled
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      return []
    }
    process.stderr.write(
      `swiz mcp: permission-policy.json unavailable at ${path}: ${messageFromUnknownError(err)}\n`
    )
    return []
  }
}

function evaluatePermissionPolicy(
  rules: CompiledPermissionRule[],
  toolName: string,
  inputPreview: string
): "allow" | "deny" | null {
  for (const rule of rules) {
    if (rule.tool !== toolName && rule.tool !== "*") continue
    if (rule.pattern) {
      if (!rule.patternRegex) {
        continue
      }
      if (!rule.patternRegex.test(inputPreview)) continue
    }
    return rule.behavior
  }
  return null
}

export { evaluatePermissionPolicy, loadPermissionPolicy }

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

let replyWriteChain = Promise.resolve()

export async function appendReplyToSink(
  cwd: string,
  payload: { content: string; kind: string },
  home = getHomeDirWithFallback("/tmp")
): Promise<void> {
  const path = swizMcpRepliesLogPath(home)
  await mkdir(dirname(path), { recursive: true })
  const row = `${JSON.stringify({
    ts: Date.now(),
    project_key: projectKeyFromCwd(cwd),
    cwd,
    kind: payload.kind,
    content: payload.content,
  })}\n`
  const queued = replyWriteChain.then(() => appendFile(path, row))
  replyWriteChain = queued.catch(() => {})
  await queued
}

// ─── Server entry point ─────────────────────────────────────────────────────

type McpToolServer = {
  registerTool: (
    name: string,
    definition: Record<string, any>,
    handler: (input: any) => any
  ) => void
}

function registerReplyTool(server: McpToolServer, cwd: string): void {
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
    async ({ content, kind }: { content: string; kind?: string }) => {
      try {
        await appendReplyToSink(cwd, { content, kind: kind ?? "note" })
        return { content: [{ type: "text" as const, text: "ok" }] }
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `reply failed: ${messageFromUnknownError(error)}` },
          ],
          isError: true,
        }
      }
    }
  )
}

/**
 * Read the project-keyed store, deleting completed tasks past the retention
 * age (COMPLETED_TASK_PRUNE_AGE_MS). The MCP task tools are the one surface
 * allowed to prune this store: a task mutation or query here is an explicit
 * agent action. Passive read paths must stay non-destructive — the daemon
 * status line once deleted the tasks it was counting (see
 * readProjectStoreTasks in compliance-routes.ts).
 */
export async function readProjectTasksWithPrune(
  projectKey: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  const tasks = await readTasks(projectKey, tasksDir)
  if (!isSafeSessionId(projectKey, tasksDir)) return tasks
  return pruneStaleCompletedTasks(join(tasksDir, projectKey), tasks)
}

function registerTaskCreateTool(server: McpToolServer, cwd: string): void {
  server.registerTool(
    "TaskCreate",
    {
      title: "Create a task",
      description:
        "Create a new task in the current session. Confirms the new task ID and returns the " +
        "in-progress and pending queue that follows it. " +
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
    async (input: { subject: string; description: string; activeForm?: string }) => {
      try {
        const projectKey = projectKeyFromCwd(cwd)
        const task = await createTaskInProcess({ sessionId: projectKey, ...input, cwd })
        const tasks = await readProjectTasksWithPrune(projectKey)
        const headline = `Created #${task.id} — ${truncateForLine(task.subject)}`
        return {
          content: [
            { type: "text" as const, text: renderTaskToolResult(headline, tasks, task.id) },
          ],
        }
      } catch (error) {
        const name = getTaskToolName("TaskCreate")
        return {
          content: [
            { type: "text" as const, text: `${name} failed: ${messageFromUnknownError(error)}` },
          ],
          isError: true,
        }
      }
    }
  )
}

interface TaskUpdateToolInput {
  taskId: string
  status?: "pending" | "in_progress" | "completed" | "cancelled"
  subject?: string
  description?: string
  addBlocks?: string[]
  removeBlocks?: string[]
  addBlockedBy?: string[]
  removeBlockedBy?: string[]
}

/** Apply the non-status fields of an update, returning a label per field actually changed. */
function applyTaskFieldUpdates(
  task: Awaited<ReturnType<typeof readTasks>>[number],
  input: TaskUpdateToolInput
): string[] {
  const changes: string[] = []
  if (input.subject !== undefined) {
    task.subject = input.subject
    changes.push("subject")
  }
  if (input.description !== undefined) {
    task.description = input.description
    changes.push("description")
  }
  if (input.addBlocks) {
    task.blocks = [...new Set([...task.blocks, ...input.addBlocks])]
    changes.push(`blocks +#${input.addBlocks.join(", #")}`)
  }
  if (input.removeBlocks) {
    task.blocks = task.blocks.filter((id) => !input.removeBlocks!.includes(id))
    changes.push(`blocks -#${input.removeBlocks.join(", #")}`)
  }
  if (input.addBlockedBy) {
    task.blockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])]
    changes.push(`blockedBy +#${input.addBlockedBy.join(", #")}`)
  }
  if (input.removeBlockedBy) {
    task.blockedBy = task.blockedBy.filter((id) => !input.removeBlockedBy!.includes(id))
    changes.push(`blockedBy -#${input.removeBlockedBy.join(", #")}`)
  }
  return changes
}

async function persistTaskUpdate(
  projectKey: string,
  cwd: string,
  task: Awaited<ReturnType<typeof readTasks>>[number],
  input: TaskUpdateToolInput,
  fieldsUpdated: boolean
): Promise<void> {
  if (input.status === undefined || input.status === task.status) {
    if (fieldsUpdated) await writeTaskUpdate(projectKey, input.taskId, task)
    return
  }
  if (fieldsUpdated) await writeTaskUpdate(projectKey, input.taskId, task)
  if (input.status === "completed") {
    await completeTaskWithAutoTransition(projectKey, input.taskId, {
      filterCwd: cwd,
      evidence: input.description,
    })
  } else {
    await updateStatus(projectKey, input.taskId, input.status, { filterCwd: cwd })
  }
}

/** A not-found error names the open tasks, so the caller can retry without a TaskList round trip. */
function renderUnknownTaskId(
  taskUpdateName: string,
  taskId: string,
  tasks: readonly Awaited<ReturnType<typeof readTasks>>[number][]
): string {
  const open = tasks.filter((task) => task.status === "pending" || task.status === "in_progress")
  if (open.length === 0) {
    return `${taskUpdateName} failed: task ${taskId} not found — this project has no open tasks.`
  }
  const listed = open
    .slice(0, MAX_LISTED_PER_GROUP)
    .map((task) => `#${task.id} ${truncateForLine(task.subject, 40)}`)
    .join(", ")
  const hidden = open.length - Math.min(open.length, MAX_LISTED_PER_GROUP)
  const suffix = hidden > 0 ? ` (+${hidden} more)` : ""
  return `${taskUpdateName} failed: task ${taskId} not found — open tasks: ${listed}${suffix}`
}

function buildUpdateHeadline(
  taskId: string,
  subject: string,
  previousStatus: string,
  input: TaskUpdateToolInput,
  fieldChanges: readonly string[]
): string {
  const parts: string[] = []
  if (input.status !== undefined && input.status !== previousStatus) {
    parts.push(`${previousStatus} → ${input.status}`)
  }
  const fields = describeTaskChanges(fieldChanges)
  if (fields) parts.push(fields)
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : " (no change)"
  return `Updated #${taskId} — ${truncateForLine(subject)}${detail}`
}

async function handleTaskUpdate(input: TaskUpdateToolInput, cwd: string) {
  const taskUpdateName = getTaskToolName("TaskUpdate")
  try {
    const projectKey = projectKeyFromCwd(cwd)
    const tasksBefore = await readProjectTasksWithPrune(projectKey)
    const task = tasksBefore.find((candidate) => candidate.id === input.taskId)
    if (!task) {
      return {
        content: [
          {
            type: "text" as const,
            text: renderUnknownTaskId(taskUpdateName, input.taskId, tasksBefore),
          },
        ],
        isError: true,
      }
    }
    const previousStatus = task.status
    // Snapshot before applyTaskFieldUpdates mutates `task` in place, so the unblock comparison
    // sees the pre-update blockedBy edges rather than the ones this call just wrote.
    const snapshotBefore = tasksBefore.map((candidate) => ({
      ...candidate,
      blockedBy: [...candidate.blockedBy],
    }))
    const fieldChanges = applyTaskFieldUpdates(task, input)
    await persistTaskUpdate(projectKey, cwd, task, input, fieldChanges.length > 0)
    const tasksAfter = await readTasks(projectKey)
    const finalTask = tasksAfter.find((candidate) => candidate.id === input.taskId)
    const headline = buildUpdateHeadline(
      input.taskId,
      finalTask?.subject ?? task.subject,
      previousStatus,
      input,
      fieldChanges
    )
    const unblocked = renderUnblockedLine(findNewlyUnblockedTasks(snapshotBefore, tasksAfter))
    const fullHeadline = unblocked ? `${headline}\n${unblocked}` : headline
    return {
      content: [
        {
          type: "text" as const,
          text: renderTaskToolResult(fullHeadline, tasksAfter, input.taskId),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${taskUpdateName} failed: ${messageFromUnknownError(error)}`,
        },
      ],
      isError: true,
    }
  }
}

function registerTaskUpdateTool(server: McpToolServer, cwd: string): void {
  server.registerTool(
    "TaskUpdate",
    {
      title: "Update a task",
      description:
        "Update an existing task's status, subject, description, or dependencies. " +
        "Status transitions: pending → in_progress → completed. " +
        "Can also add/remove task blocking relationships. Confirms what changed and returns " +
        "the resulting in-progress and pending queue.",
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
        removeBlocks: z
          .array(z.string())
          .optional()
          .describe("List of task IDs to remove from blocks"),
        addBlockedBy: z
          .array(z.string())
          .optional()
          .describe("List of task IDs that should block this task"),
        removeBlockedBy: z
          .array(z.string())
          .optional()
          .describe("List of task IDs to remove from blockedBy"),
      },
    },
    (input: TaskUpdateToolInput) => handleTaskUpdate(input, cwd)
  )
}

// Re-exported for consumers that summarised task counts from this module before the
// rendering moved into task-mcp-view.ts.
export { summarizeTasks }
export type { TaskListSummary }

function registerTaskListTool(server: McpToolServer, cwd: string): void {
  server.registerTool(
    "TaskList",
    {
      title: "List all tasks",
      description:
        "Show the current session's open work: in-progress and pending tasks with their IDs, " +
        "elapsed time and blockers, plus counts for completed and cancelled tasks. " +
        "Long lists are truncated with an explicit remainder count.",
      inputSchema: {},
    },
    async () => {
      try {
        const allTasks = await readProjectTasksWithPrune(projectKeyFromCwd(cwd))
        const headline =
          allTasks.length === 0 ? "No tasks in this project yet." : "Task queue for this project."
        return {
          content: [{ type: "text" as const, text: renderTaskToolResult(headline, allTasks) }],
        }
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `TaskList failed: ${messageFromUnknownError(error)}` },
          ],
          isError: true,
        }
      }
    }
  )
}

async function serve(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

  const cwd = process.cwd()
  const settings = await readSwizSettings()
  const mcpChannels = settings.mcpChannels

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: buildMcpCapabilities(mcpChannels),
      instructions: buildMcpInstructions(mcpChannels),
    }
  )

  registerReplyTool(server, cwd)

  registerTaskCreateTool(server, cwd)

  registerTaskUpdateTool(server, cwd)

  registerTaskListTool(server, cwd)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  activeServer = server as unknown as typeof activeServer

  const lowLevel = (server as unknown as { server: McpLowLevelServer }).server
  if (mcpChannels) {
    try {
      registerPermissionRelay(lowLevel, cwd)
    } catch (err) {
      process.stderr.write(`swiz mcp: failed to register permission relay: ${String(err)}\n`)
    }
  }

  const enabledFeatures = mcpChannels
    ? "channel + permission + reply + task-tools"
    : "reply + task-tools"
  process.stderr.write(
    `swiz mcp server ready (${SERVER_NAME} ${SERVER_VERSION}) — ${enabledFeatures} enabled\n`
  )

  const stopDrain = mcpChannels ? startAutoSteerDrainLoop(cwd) : () => {}
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
  description: "Run swiz as a Model Context Protocol (MCP) stdio server",
  usage: "swiz mcp",
  async run() {
    await serve()
  },
}
