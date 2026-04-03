import { join } from "node:path"
import { z } from "zod"
import { getHomeDir } from "../../home.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import { appendJsonlEntry, readJsonlFileTail } from "../../utils/jsonl.ts"
import type { SessionMessage, SessionTaskSummary, ToolCallSummary } from "./types.ts"

export type { SessionMessage, SessionTaskSummary, ToolCallSummary } from "./types.ts"

import {
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  launchAgentExists,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"
import { projectKeyFromCwd } from "../../project-key.ts"
import { isIncompleteTaskStatus, type Task as StoredTask } from "../../tasks/task-repository.ts"
import { extractText } from "../../transcript-utils.ts"

export interface TranscriptWatchPath {
  path: string
  label: string
}

const watchPathsCache = new Map<string, TranscriptWatchPath[]>()

export function transcriptWatchPathsForProject(cwd: string): TranscriptWatchPath[] {
  const cached = watchPathsCache.get(cwd)
  if (cached) return cached

  const home = getHomeDir()
  const projectKey = projectKeyFromCwd(cwd)
  const paths: TranscriptWatchPath[] = [
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
    {
      path: join(home, ".junie", "sessions", "/"),
      label: `transcripts:junie:${cwd}`,
    },
  ]
  watchPathsCache.set(cwd, paths)
  return paths
}

export async function listDaemonPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
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

function tryKill(pid: number, signal?: string): void {
  try {
    process.kill(pid, signal)
  } catch {
    // process may have already exited
  }
}

export async function restartDaemonOnPort(
  port: number,
  selfPid: number = process.pid
): Promise<void> {
  const existing = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  if (existing.length === 0) return

  for (const pid of existing) {
    tryKill(pid)
  }

  // Give processes a short grace period to exit before forcing.
  for (let attempt = 0; attempt < 6; attempt++) {
    await Bun.sleep(200)
    const remaining = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
    if (remaining.length === 0) return
    if (attempt === 5) {
      for (const pid of remaining) {
        tryKill(pid, "SIGKILL")
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

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

export interface CapturedToolCall {
  name: string
  detail: string
  timestamp: string
}

export interface SessionToolUsageState extends CurrentSessionToolUsage {
  lastSeen: number
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

export const MAX_CAPTURED_TOOL_CALLS_PER_SESSION = 400
const capturedToolCallSchema = z.object({
  name: z.string(),
  detail: z.string(),
  timestamp: z.string(),
})

function formatToolInputForDisplay(input: Record<string, any> | undefined): string {
  return summarizeToolInput(input)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function summarizeTaskInput(input: Record<string, any>): string | null {
  if (typeof input.subject === "string") return truncate(input.subject, 60)
  if (typeof input.taskId === "string") {
    const parts = [`#${input.taskId}`]
    if (typeof input.status === "string") parts.push(input.status)
    return parts.join(" -> ")
  }
  return null
}

function extractPathValue(input: Record<string, any>): string | undefined {
  const v = input.path ?? input.file_path ?? input.file ?? input.filePath
  return typeof v === "string" ? v : undefined
}

function summarizeFileOrCommandInput(input: Record<string, any>): string | null {
  if (typeof input.skill === "string") {
    return typeof input.args === "string" ? `${input.skill} ${input.args}` : input.skill
  }
  const pathVal = extractPathValue(input)
  if (pathVal !== undefined) return pathVal
  if (typeof input.command === "string") return truncate(input.command, 80)
  if (typeof input.pattern === "string") return input.pattern
  if (typeof input.query === "string") return truncate(input.query, 60)
  if (typeof input.content === "string") return `${input.content.length} chars`
  if (typeof input.old_string === "string") {
    return `replacing ${input.old_string.split("\n").length} lines`
  }
  return null
}

export function summarizeToolInput(input: Record<string, any> | undefined): string {
  if (!input) return ""
  return summarizeTaskInput(input) ?? summarizeFileOrCommandInput(input) ?? ""
}

export function captureSessionToolCall(
  sessionToolCalls: Map<string, CapturedToolCall[]>,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number
): void {
  const list = sessionToolCalls.get(sessionId) ?? []
  list.push(buildCapturedToolCall(toolName, toolInput, nowMs))
  if (list.length > MAX_CAPTURED_TOOL_CALLS_PER_SESSION) {
    list.splice(0, list.length - MAX_CAPTURED_TOOL_CALLS_PER_SESSION)
  }
  sessionToolCalls.set(sessionId, list)
}

function buildCapturedToolCall(
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number
): CapturedToolCall {
  return {
    name: toolName,
    detail: summarizeToolInput(toolInput),
    timestamp: new Date(nowMs).toISOString(),
  }
}

export function capturedSessionToolCallLogPath(
  cwd: string,
  sessionId: string,
  homeDir = getHomeDir()
): string {
  return join(
    homeDir,
    ".swiz",
    "daemon",
    "session-tool-calls",
    projectKeyFromCwd(cwd),
    `${encodeURIComponent(sessionId)}.jsonl`
  )
}

export async function persistSessionToolCall(
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number,
  homeDir = getHomeDir()
): Promise<void> {
  const path = capturedSessionToolCallLogPath(cwd, sessionId, homeDir)
  await appendJsonlEntry(path, buildCapturedToolCall(toolName, toolInput, nowMs))
}

export async function readPersistedSessionToolCalls(
  cwd: string,
  sessionId: string,
  limit = MAX_CAPTURED_TOOL_CALLS_PER_SESSION,
  homeDir = getHomeDir()
): Promise<CapturedToolCall[]> {
  const path = capturedSessionToolCallLogPath(cwd, sessionId, homeDir)
  return readJsonlFileTail(path, capturedToolCallSchema, limit)
}

export function mergeCapturedToolCalls(...sources: CapturedToolCall[][]): CapturedToolCall[] {
  const merged: CapturedToolCall[] = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const entry of source) {
      const key = `${entry.timestamp}\x00${entry.name}\x00${entry.detail}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }

  return merged.length > MAX_CAPTURED_TOOL_CALLS_PER_SESSION
    ? merged.slice(-MAX_CAPTURED_TOOL_CALLS_PER_SESSION)
    : merged
}

export function seedSessionToolUsage(
  sessionToolUsage: Map<string, SessionToolUsageState>,
  sessionId: string,
  usage: CurrentSessionToolUsage,
  nowMs: number
): SessionToolUsageState {
  const entry: SessionToolUsageState = {
    toolNames: [...usage.toolNames],
    skillInvocations: [...usage.skillInvocations],
    lastSeen: nowMs,
  }
  sessionToolUsage.set(sessionId, entry)
  return entry
}

export function captureSessionToolUsage(
  sessionToolUsage: Map<string, SessionToolUsageState>,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number
): SessionToolUsageState {
  const existing = sessionToolUsage.get(sessionId)
  const entry: SessionToolUsageState = existing
    ? {
        toolNames: existing.toolNames,
        skillInvocations: existing.skillInvocations,
        lastSeen: nowMs,
      }
    : {
        toolNames: [],
        skillInvocations: [],
        lastSeen: nowMs,
      }

  entry.toolNames.push(toolName)
  if (toolName === "Skill" && typeof toolInput?.skill === "string" && toolInput.skill) {
    entry.skillInvocations.push(toolInput.skill)
  }
  sessionToolUsage.set(sessionId, entry)
  return entry
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

  const assistantIndexes = messages
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((index) => index >= 0)

  if (assistantIndexes.length === 0) {
    const next = [...messages]
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

  const next = messages.map((m) =>
    m.role === "assistant"
      ? {
          ...m,
          toolCalls: m.toolCalls ? [...m.toolCalls] : [],
        }
      : m
  )

  let targetIdx = 0
  for (const call of captured) {
    const messageIndex = assistantIndexes[Math.min(targetIdx, assistantIndexes.length - 1)]!
    const target = next[messageIndex] as SessionMessage
    target.toolCalls!.push({ name: call.name, detail: call.detail })
    targetIdx++
  }
  return next
}

export function extractToolCalls(content: unknown): ToolCallSummary[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (block): block is { type: string; name?: string; input?: Record<string, any> } =>
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
    open: tasks.filter((task) => isIncompleteTaskStatus(task.status)).length,
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
    open: tasks.filter((task) => isIncompleteTaskStatus(task.status)).length,
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
