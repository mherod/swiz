import { join } from "node:path"
import { getHomeDir } from "../../home.ts"
import {
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  launchAgentExists,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"
import { projectKeyFromCwd } from "../../project-key.ts"
import type { Task as StoredTask } from "../../tasks/task-repository.ts"
import { extractText } from "../../transcript-utils.ts"

export interface TranscriptWatchPath {
  path: string
  label: string
}

export function transcriptWatchPathsForProject(cwd: string): TranscriptWatchPath[] {
  const home = getHomeDir()
  const projectKey = projectKeyFromCwd(cwd)
  return [
    {
      path: join(home, ".claude", "projects", projectKey, "/"),
      label: `transcripts:claude:${cwd}`,
    },
    {
      path: join(home, ".cursor", "projects", projectKey, "agent-transcripts", "/"),
      label: `transcripts:cursor-agent:${cwd}`,
    },
    {
      path: join(home, ".cursor", "chats", "/"),
      label: `transcripts:cursor-chats:${cwd}`,
    },
    {
      path: join(home, ".gemini", "tmp", "/"),
      label: `transcripts:gemini:${cwd}`,
    },
    {
      path: join(home, ".codex", "sessions", "/"),
      label: `transcripts:codex:${cwd}`,
    },
  ]
}

export async function listDaemonPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) return []
  return [
    ...new Set(
      out
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => pid > 0)
    ),
  ]
}

export async function restartDaemonOnPort(
  port: number,
  selfPid: number = process.pid
): Promise<void> {
  const existing = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  if (existing.length === 0) return

  for (const pid of existing) {
    Bun.spawnSync(["kill", String(pid)], { stdout: "ignore", stderr: "ignore" })
  }

  // Give processes a short grace period to exit before forcing.
  for (let attempt = 0; attempt < 6; attempt++) {
    await Bun.sleep(200)
    const remaining = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
    if (remaining.length === 0) return
    if (attempt === 5) {
      for (const pid of remaining) {
        Bun.spawnSync(["kill", "-9", String(pid)], { stdout: "ignore", stderr: "ignore" })
      }
    }
  }

  const finalRemaining = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  if (finalRemaining.length > 0) {
    throw new Error(
      `Failed to restart daemon: port ${port} still in use by ${finalRemaining.join(", ")}`
    )
  }
}

export interface RestartDaemonResult {
  mode: "launchagent" | "port"
  hadRunning: boolean
  stoppedCount: number
}

export async function restartDaemon(
  port: number,
  selfPid: number = process.pid
): Promise<RestartDaemonResult> {
  if (await launchAgentExists(SWIZ_DAEMON_LABEL)) {
    const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
    const loaded = await isLaunchAgentLoaded(SWIZ_DAEMON_LABEL)
    if (loaded) {
      const unloadExit = await unloadLaunchAgent(plistPath)
      if (unloadExit !== 0) {
        throw new Error(`Failed to unload ${SWIZ_DAEMON_LABEL}`)
      }
    }
    const loadExit = await loadLaunchAgent(plistPath)
    if (loadExit !== 0) {
      throw new Error(`Failed to load ${SWIZ_DAEMON_LABEL}`)
    }
    return {
      mode: "launchagent",
      hadRunning: loaded,
      stoppedCount: loaded ? 1 : 0,
    }
  }

  const existing = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  await restartDaemonOnPort(port, selfPid)
  return {
    mode: "port",
    hadRunning: existing.length > 0,
    stoppedCount: existing.length,
  }
}

export function stripAnsi(text: string): string {
  const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
  return text.replace(ansiRe, "")
}

export interface ToolCallSummary {
  name: string
  detail: string
}

export interface CapturedToolCall {
  name: string
  detail: string
  timestamp: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  timestamp: string | null
  text: string
  toolCalls?: ToolCallSummary[]
}

export interface SessionTaskSummary {
  total: number
  open: number
  completed: number
  cancelled: number
}

export interface SessionTaskPreview {
  id: string
  subject: string
  status: StoredTask["status"]
  statusChangedAt: string | null
  completionTimestamp: string | null
  completionEvidence: string | null
}

export interface ProjectTaskPreview extends SessionTaskPreview {
  sessionId: string
}

const MAX_CAPTURED_TOOL_CALLS_PER_SESSION = 400

function formatToolInputForDisplay(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return summarizeToolInput(input)
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function summarizeTaskInput(input: Record<string, unknown>): string | null {
  if (typeof input.subject === "string") return truncate(input.subject, 60)
  if (typeof input.taskId === "string") {
    const parts = [`#${input.taskId}`]
    if (typeof input.status === "string") parts.push(input.status)
    return parts.join(" -> ")
  }
  return null
}

function summarizeFileOrCommandInput(input: Record<string, unknown>): string | null {
  if (typeof input.skill === "string") {
    return typeof input.args === "string" ? `${input.skill} ${input.args}` : input.skill
  }
  const pathVal = input.path ?? input.file_path ?? input.file ?? input.filePath
  if (typeof pathVal === "string") return pathVal
  if (typeof input.command === "string") return truncate(input.command, 80)
  if (typeof input.pattern === "string") return input.pattern
  if (typeof input.query === "string") return truncate(input.query, 60)
  if (typeof input.content === "string") return `${input.content.length} chars`
  if (typeof input.old_string === "string") {
    return `replacing ${input.old_string.split("\n").length} lines`
  }
  return null
}

export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  return summarizeTaskInput(input) ?? summarizeFileOrCommandInput(input) ?? ""
}

export function captureSessionToolCall(
  sessionToolCalls: Map<string, CapturedToolCall[]>,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  nowMs: number
): void {
  const list = sessionToolCalls.get(sessionId) ?? []
  list.push({
    name: toolName,
    detail: summarizeToolInput(toolInput),
    timestamp: new Date(nowMs).toISOString(),
  })
  if (list.length > MAX_CAPTURED_TOOL_CALLS_PER_SESSION) {
    list.splice(0, list.length - MAX_CAPTURED_TOOL_CALLS_PER_SESSION)
  }
  sessionToolCalls.set(sessionId, list)
}

export function mergeToolStats(
  base: Array<{ name: string; count: number }>,
  supplemental: ToolCallSummary[]
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of base) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }
  for (const call of supplemental) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export function supplementMessagesWithCapturedToolCalls(
  messages: SessionMessage[],
  captured: CapturedToolCall[]
): SessionMessage[] {
  if (captured.length === 0) return messages

  const next = messages.map((message) => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}),
  }))
  const assistantIndexes = next
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((index) => index >= 0)

  if (assistantIndexes.length === 0) {
    for (const call of captured) {
      next.push({
        role: "assistant",
        timestamp: call.timestamp,
        text: "",
        toolCalls: [{ name: call.name, detail: call.detail }],
      })
    }
    return next.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
  }

  let targetIdx = 0
  for (const call of captured) {
    const messageIndex = assistantIndexes[Math.min(targetIdx, assistantIndexes.length - 1)]!
    const target = next[messageIndex]!
    const existing = target.toolCalls ?? []
    target.toolCalls = [...existing, { name: call.name, detail: call.detail }]
    targetIdx++
  }
  return next
}

export function extractToolCalls(content: unknown): ToolCallSummary[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (block): block is { type: string; name?: string; input?: Record<string, unknown> } =>
        !!block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        typeof block.name === "string"
    )
    .map((block) => {
      const name = block.name!
      return { name, detail: formatToolInputForDisplay(block.input) }
    })
}

export function extractMessageText(content: unknown): string {
  return extractText(content as string | { type: string; text?: string }[] | undefined).trim()
}

function taskStatusRank(status: StoredTask["status"]): number {
  switch (status) {
    case "in_progress":
      return 0
    case "pending":
      return 1
    case "completed":
      return 2
    case "cancelled":
      return 3
    default:
      return 4
  }
}

export function buildSessionTasksView(
  tasks: StoredTask[],
  limit: number
): { tasks: SessionTaskPreview[]; summary: SessionTaskSummary } {
  const summary: SessionTaskSummary = {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "pending" || task.status === "in_progress").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  }
  const sorted = [...tasks].sort((a, b) => {
    const rankDiff = taskStatusRank(a.status) - taskStatusRank(b.status)
    if (rankDiff !== 0) return rankDiff
    const aTs = a.statusChangedAt ?? a.completionTimestamp ?? ""
    const bTs = b.statusChangedAt ?? b.completionTimestamp ?? ""
    if (aTs !== bTs) return bTs.localeCompare(aTs)
    return b.id.localeCompare(a.id)
  })
  return {
    tasks: sorted.slice(0, limit).map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      statusChangedAt: task.statusChangedAt ?? null,
      completionTimestamp: task.completionTimestamp ?? null,
      completionEvidence: task.completionEvidence ?? null,
    })),
    summary,
  }
}

export function buildProjectTasksView(
  tasks: ProjectTaskPreview[],
  limit: number
): { tasks: ProjectTaskPreview[]; summary: SessionTaskSummary } {
  const summary: SessionTaskSummary = {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "pending" || task.status === "in_progress").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  }
  const sorted = [...tasks].sort((a, b) => {
    const rankDiff = taskStatusRank(a.status) - taskStatusRank(b.status)
    if (rankDiff !== 0) return rankDiff
    const aTs = a.statusChangedAt ?? a.completionTimestamp ?? ""
    const bTs = b.statusChangedAt ?? b.completionTimestamp ?? ""
    if (aTs !== bTs) return bTs.localeCompare(aTs)
    if (a.sessionId !== b.sessionId) return b.sessionId.localeCompare(a.sessionId)
    return b.id.localeCompare(a.id)
  })
  return {
    tasks: sorted.slice(0, limit),
    summary,
  }
}
