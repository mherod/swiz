import { join } from "node:path"
import { z } from "zod"
import { getHomeDir } from "../../home.ts"
import type { CurrentSessionToolUsage, CurrentSessionUsageEvent } from "../../transcript-summary.ts"
import { appendJsonlEntry, readJsonlFileTail } from "../../utils/jsonl.ts"
import type { SessionMessage, SessionTaskSummary, ToolCallSummary } from "./types.ts"

export type { SessionMessage, SessionTaskSummary, ToolCallSummary } from "./types.ts"

import { projectKeyFromCwd } from "../../project-key.ts"
import {
  extractPathValuesFromToolInput,
  extractSkillNameFromCapturedSkillDetail,
  extractSkillNameFromToolInput,
  extractSkillNamesFromPathValues,
  extractSkillNamesFromShellSkillUsageCommand,
  formatSkillToolInputDetail,
} from "../../skill-usage.ts"
import { isIncompleteTaskStatus } from "../../tasks/task-repository.ts"
import {
  extractFileEditTargetPaths,
  extractFileReadTargetPaths,
  isCodeChangeTool,
  isFileEditTool,
  isShellTool,
  isTaskTool,
  READ_TOOLS,
} from "../../tool-matchers.ts"
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
  ]
  watchPathsCache.set(cwd, paths)
  return paths
}

// Process control helpers extracted to process-control.ts
export {
  listDaemonPids,
  type RestartDaemonResult,
  restartDaemon,
  restartDaemonOnPort,
} from "./process-control.ts"

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
  status: string
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

function formatToolInputForDisplay(name: string, input: Record<string, any> | undefined): string {
  return summarizeToolInput(input, name)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

/**
 * Task tool inputs (taskId, status, subject, description, activeForm) are small
 * and bounded, so we keep the full JSON rather than collapsing to a one-line
 * summary — the dashboard's TaskToolDisplay parses this JSON back out to show
 * per-field state instead of just the action name.
 */
function taskToolDetail(input: Record<string, any>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function extractPathValue(input: Record<string, any>): string | undefined {
  const v = input.path ?? input.file_path ?? input.file ?? input.filePath
  return typeof v === "string" ? v : undefined
}

function isFileTool(name: string): boolean {
  return READ_TOOLS.has(name) || isCodeChangeTool(name)
}

const FILE_DETAIL_STRING_TRUNCATE = 2000
const GENERIC_TOOL_DETAIL_TRUNCATE = 2000

/**
 * File tool inputs (Read/Edit/Write/NotebookEdit) keep their path plus a bounded
 * slice of any diff strings, instead of collapsing to a path-only summary — the
 * dashboard's FileToolDisplay parses this JSON to show offset/limit and the
 * old/new diff, not just the tool name.
 */
function fileToolDetail(input: Record<string, any>): string {
  const pathVal = extractPathValue(input)
  if (pathVal === undefined) return summarizeFileOrCommandInput(input) ?? ""
  const payload: Record<string, unknown> = { file_path: pathVal }
  if (typeof input.offset === "number") payload.offset = input.offset
  if (typeof input.limit === "number") payload.limit = input.limit
  if (typeof input.old_string === "string") {
    payload.old_string = truncate(input.old_string, FILE_DETAIL_STRING_TRUNCATE)
  }
  if (typeof input.new_string === "string") {
    payload.new_string = truncate(input.new_string, FILE_DETAIL_STRING_TRUNCATE)
  }
  try {
    return JSON.stringify(payload)
  } catch {
    return summarizeFileOrCommandInput(input) ?? ""
  }
}

function summarizeFileOrCommandInput(input: Record<string, any>): string | null {
  const skillDetail = formatSkillToolInputDetail(input)
  if (skillDetail) return skillDetail
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

export function summarizeToolInput(input: Record<string, any> | undefined, name?: string): string {
  if (!input) return ""
  if (name && isTaskTool(name)) return taskToolDetail(input)
  if (name && isFileTool(name)) return fileToolDetail(input)
  const summary = summarizeFileOrCommandInput(input)
  if (summary) return summary
  // Keep unknown provider-specific payloads inspectable without retaining unbounded blobs.
  try {
    return truncate(JSON.stringify(input), GENERIC_TOOL_DETAIL_TRUNCATE)
  } catch {
    return ""
  }
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
    detail: summarizeToolInput(toolInput, toolName),
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

type PersistSessionToolCallArgs = [
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number,
  homeDir?: string,
]

export const persistSessionToolCall = async (
  ...args: PersistSessionToolCallArgs
): Promise<void> => {
  const [cwd, sessionId, toolName, toolInput, nowMs, homeDir = getHomeDir()] = args
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

function usageEventsFromCapturedCalls(calls: CapturedToolCall[]): CurrentSessionUsageEvent[] {
  const events: CurrentSessionUsageEvent[] = []
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!
    events.push({ kind: "tool", value: call.name, turnIndex: index, timestamp: call.timestamp })
    if (call.name === "Skill") {
      const skill = extractSkillNameFromCapturedSkillDetail(call.detail)
      if (skill)
        events.push({
          kind: "skill",
          value: skill,
          turnIndex: index,
          timestamp: call.timestamp,
          source: "agent",
        })
    }
    if (READ_TOOLS.has(call.name) && call.detail) {
      events.push({
        kind: "read-file",
        value: call.detail,
        turnIndex: index,
        timestamp: call.timestamp,
        source: "agent",
      })
    }
    if (isFileEditTool(call.name) && call.detail) {
      events.push({
        kind: "written-file",
        value: call.detail,
        turnIndex: index,
        timestamp: call.timestamp,
        source: "agent",
      })
    }
  }
  return events
}

function appendUnique(target: string[], value: string | null | undefined): void {
  if (value && !target.includes(value)) target.push(value)
}

function accumulateCapturedCallDetails(calls: CapturedToolCall[]): {
  skillInvocations: string[]
  readFiles: string[]
  writtenFiles: string[]
} {
  const skillInvocations: string[] = []
  const readFiles: string[] = []
  const writtenFiles: string[] = []
  for (const call of calls) {
    if (call.name === "Skill") {
      appendUnique(skillInvocations, extractSkillNameFromCapturedSkillDetail(call.detail))
    } else if (READ_TOOLS.has(call.name)) {
      appendUnique(readFiles, call.detail)
    } else if (isFileEditTool(call.name)) {
      appendUnique(writtenFiles, call.detail)
    }
  }
  return { skillInvocations, readFiles, writtenFiles }
}

export function buildSessionToolUsageStateFromCapturedCalls(
  calls: CapturedToolCall[],
  lastSeen: number
): SessionToolUsageState {
  const { skillInvocations, readFiles, writtenFiles } = accumulateCapturedCallDetails(calls)
  return {
    toolNames: calls.map((call) => call.name),
    skillInvocations,
    readFiles,
    writtenFiles,
    events: usageEventsFromCapturedCalls(calls),
    lastSeen,
  }
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
    readFiles: Array.isArray(usage.readFiles) ? [...usage.readFiles] : [],
    writtenFiles: Array.isArray(usage.writtenFiles) ? [...usage.writtenFiles] : [],
    events: usage.events ? [...usage.events] : undefined,
    lastSeen: nowMs,
  }
  sessionToolUsage.set(sessionId, entry)
  return entry
}

function extractDirectSkillNamesFromTool(
  toolName: string,
  toolInput: Record<string, any> | undefined
): string[] {
  if (!toolInput) return []
  if (READ_TOOLS.has(toolName)) {
    return extractSkillNamesFromPathValues(extractPathValuesFromToolInput(toolInput))
  }
  if (isShellTool(toolName)) {
    const cmd = (toolInput.command ?? toolInput.cmd ?? "") as string
    return extractSkillNamesFromShellSkillUsageCommand(cmd)
  }
  return []
}

function captureSkillInvocations(
  entry: SessionToolUsageState,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  turnIndex: number,
  timestamp: string
): void {
  const explicitSkill = toolName === "Skill" ? extractSkillNameFromToolInput(toolInput) : null
  const directSkills = extractDirectSkillNamesFromTool(toolName, toolInput)
  const skillsToRecord = explicitSkill ? [explicitSkill, ...directSkills] : directSkills

  for (const skill of skillsToRecord) {
    if (!entry.skillInvocations.includes(skill)) entry.skillInvocations.push(skill)
    entry.events?.push({ kind: "skill", value: skill, turnIndex, timestamp, source: "agent" })
  }
}

function captureReadFileTargets(
  entry: SessionToolUsageState,
  toolInput: Record<string, any> | undefined,
  turnIndex: number,
  timestamp: string
): void {
  if (!entry.readFiles) entry.readFiles = []
  for (const filePath of extractFileReadTargetPaths(toolInput ?? {})) {
    if (!entry.readFiles.includes(filePath)) entry.readFiles.push(filePath)
    entry.events?.push({
      kind: "read-file",
      value: filePath,
      turnIndex,
      timestamp,
      source: "agent",
    })
  }
}

function captureWrittenFileTargets(
  entry: SessionToolUsageState,
  toolInput: Record<string, any> | undefined,
  turnIndex: number,
  timestamp: string
): void {
  if (!entry.writtenFiles) entry.writtenFiles = []
  for (const filePath of extractFileEditTargetPaths(toolInput ?? {})) {
    if (!entry.writtenFiles.includes(filePath)) entry.writtenFiles.push(filePath)
    entry.events?.push({
      kind: "written-file",
      value: filePath,
      turnIndex,
      timestamp,
      source: "agent",
    })
  }
}

function captureFileTargets(
  entry: SessionToolUsageState,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  turnIndex: number,
  timestamp: string
): void {
  if (READ_TOOLS.has(toolName)) {
    captureReadFileTargets(entry, toolInput, turnIndex, timestamp)
  }
  if (isFileEditTool(toolName)) {
    captureWrittenFileTargets(entry, toolInput, turnIndex, timestamp)
  }
}

function getOrCreateSessionToolUsageEntry(
  existing: SessionToolUsageState | undefined,
  nowMs: number
): SessionToolUsageState {
  if (existing) {
    return {
      toolNames: existing.toolNames,
      skillInvocations: existing.skillInvocations,
      readFiles: existing.readFiles ?? [],
      writtenFiles: existing.writtenFiles ?? [],
      events: existing.events ?? [],
      lastSeen: nowMs,
    }
  }
  return {
    toolNames: [],
    skillInvocations: [],
    readFiles: [],
    writtenFiles: [],
    events: [],
    lastSeen: nowMs,
  }
}

export function captureSessionToolUsage(
  sessionToolUsage: Map<string, SessionToolUsageState>,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number
): SessionToolUsageState {
  const entry = getOrCreateSessionToolUsageEntry(sessionToolUsage.get(sessionId), nowMs)
  const turnIndex = entry.toolNames.length
  const timestamp = new Date(nowMs).toISOString()

  entry.toolNames.push(toolName)
  entry.events?.push({ kind: "tool", value: toolName, turnIndex, timestamp })

  captureSkillInvocations(entry, toolName, toolInput, turnIndex, timestamp)
  captureFileTargets(entry, toolName, toolInput, turnIndex, timestamp)

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
      return { name, detail: formatToolInputForDisplay(name, block.input) }
    })
}

export function extractMessageText(content: unknown): string {
  return extractText(content as string | { type: string; text?: string }[] | undefined).trim()
}

function taskStatusRank(status: string): number {
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

/** Minimal fields needed by buildSessionTasksView — accepts both Task and SessionTask. */
interface TaskViewInput {
  id: string
  subject: string
  status: string
  statusChangedAt?: string | null
  completionTimestamp?: string | null
  completionEvidence?: string | null
}

export function buildSessionTasksView(
  tasks: TaskViewInput[],
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
