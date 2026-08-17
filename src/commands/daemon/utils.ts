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
  nextTurnIndex?: number
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
export const MAX_SESSION_TOOL_HISTORY = 400
export const MAX_SESSION_UNIQUE_SKILLS = 100
export const MAX_SESSION_UNIQUE_READ_FILES = 200
export const MAX_SESSION_UNIQUE_WRITTEN_FILES = 200
export const MAX_HYDRATED_SESSIONS = 30
export const HYDRATION_CONCURRENCY = 4

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

function execCodeDetail(input: Record<string, any>, name?: string): string | null {
  if (name?.toLowerCase() !== "exec" || typeof input.code !== "string") return null
  return truncate(input.code, GENERIC_TOOL_DETAIL_TRUNCATE)
}

export function summarizeToolInput(input: Record<string, any> | undefined, name?: string): string {
  if (!input) return ""
  if (name && isTaskTool(name)) return taskToolDetail(input)
  if (name && isFileTool(name)) return fileToolDetail(input)
  const execCode = execCodeDetail(input, name)
  if (execCode) return execCode
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

function dedupePreservingRecency(items: string[] | undefined, max: number): string[] {
  if (!items || items.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && !seen.has(item)) {
      seen.add(item)
      result.push(item)
      if (result.length >= max) break
    }
  }
  return result.reverse()
}

function dedupeEvents(
  events: CurrentSessionUsageEvent[] | undefined,
  max: number
): CurrentSessionUsageEvent[] | undefined {
  if (!events) return undefined
  if (events.length === 0) return []
  const seen = new Set<string>()
  const result: CurrentSessionUsageEvent[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event) continue
    const key = `${event.kind}|${event.value}|${event.timestamp ?? ""}|${event.source ?? ""}|${event.turnIndex}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push({ ...event })
      if (result.length >= max) break
    }
  }
  return result.reverse()
}

function resolveNextTurnIndex(
  explicitNextTurn: number | undefined,
  toolNamesCount: number,
  events?: CurrentSessionUsageEvent[]
): number {
  let maxTurn = Math.max(explicitNextTurn ?? 0, toolNamesCount)
  if (events) {
    for (const ev of events) {
      if (typeof ev.turnIndex === "number" && ev.turnIndex >= maxTurn) {
        maxTurn = ev.turnIndex + 1
      }
    }
  }
  return maxTurn
}

export function normalizeSessionToolUsageState(state: {
  toolNames: string[]
  skillInvocations: string[]
  readFiles?: string[]
  writtenFiles?: string[]
  events?: CurrentSessionUsageEvent[]
  lastSeen: number
  nextTurnIndex?: number
}): SessionToolUsageState {
  const toolNames = state.toolNames.slice(-MAX_SESSION_TOOL_HISTORY)
  const skillInvocations = dedupePreservingRecency(
    state.skillInvocations,
    MAX_SESSION_UNIQUE_SKILLS
  )
  const readFiles = state.readFiles
    ? dedupePreservingRecency(state.readFiles, MAX_SESSION_UNIQUE_READ_FILES)
    : []
  const writtenFiles = state.writtenFiles
    ? dedupePreservingRecency(state.writtenFiles, MAX_SESSION_UNIQUE_WRITTEN_FILES)
    : []
  const events = dedupeEvents(state.events, MAX_SESSION_TOOL_HISTORY)
  const nextTurnIndex = resolveNextTurnIndex(
    state.nextTurnIndex,
    state.toolNames.length,
    state.events
  )

  return {
    toolNames,
    skillInvocations,
    readFiles,
    writtenFiles,
    events,
    lastSeen: typeof state.lastSeen === "number" ? state.lastSeen : Date.now(),
    nextTurnIndex,
  }
}

export function mergeSessionToolUsageStates(
  existing: SessionToolUsageState | undefined,
  recovered: SessionToolUsageState
): SessionToolUsageState {
  if (!existing) return normalizeSessionToolUsageState(recovered)
  return normalizeSessionToolUsageState({
    toolNames: [...existing.toolNames, ...recovered.toolNames],
    skillInvocations: [...existing.skillInvocations, ...recovered.skillInvocations],
    readFiles: [...(existing.readFiles ?? []), ...(recovered.readFiles ?? [])],
    writtenFiles: [...(existing.writtenFiles ?? []), ...(recovered.writtenFiles ?? [])],
    events: [...(existing.events ?? []), ...(recovered.events ?? [])],
    lastSeen: Math.max(existing.lastSeen, recovered.lastSeen),
    nextTurnIndex: Math.max(
      existing.nextTurnIndex ?? existing.toolNames.length,
      recovered.nextTurnIndex ?? recovered.toolNames.length
    ),
  })
}

export function buildSessionToolUsageStateFromCapturedCalls(
  calls: CapturedToolCall[],
  lastSeen: number
): SessionToolUsageState {
  const { skillInvocations, readFiles, writtenFiles } = accumulateCapturedCallDetails(calls)
  return normalizeSessionToolUsageState({
    toolNames: calls.map((call) => call.name),
    skillInvocations,
    readFiles,
    writtenFiles,
    events: usageEventsFromCapturedCalls(calls),
    lastSeen,
    nextTurnIndex: calls.length,
  })
}

export function seedSessionToolUsage(
  sessionToolUsage: Map<string, SessionToolUsageState>,
  sessionId: string,
  usage: CurrentSessionToolUsage,
  nowMs: number
): SessionToolUsageState {
  const normalized = normalizeSessionToolUsageState({
    toolNames: usage.toolNames,
    skillInvocations: usage.skillInvocations,
    readFiles: usage.readFiles,
    writtenFiles: usage.writtenFiles,
    events: usage.events,
    lastSeen: nowMs,
  })
  sessionToolUsage.set(sessionId, normalized)
  return normalized
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
    entry.skillInvocations.push(skill)
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
    entry.readFiles.push(filePath)
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
    entry.writtenFiles.push(filePath)
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

function createDraftFromExisting(
  existing: SessionToolUsageState,
  toolName: string,
  nowMs: number
): { draft: SessionToolUsageState; turnIndex: number; timestamp: string } {
  const turnIndex = existing.nextTurnIndex ?? existing.toolNames.length
  const timestamp = new Date(nowMs).toISOString()
  const events = existing.events ? existing.events.map((e) => ({ ...e })) : []
  events.push({ kind: "tool", value: toolName, turnIndex, timestamp })

  return {
    draft: {
      toolNames: [...existing.toolNames, toolName],
      skillInvocations: [...existing.skillInvocations],
      readFiles: existing.readFiles ? [...existing.readFiles] : [],
      writtenFiles: existing.writtenFiles ? [...existing.writtenFiles] : [],
      events,
      lastSeen: nowMs,
      nextTurnIndex: turnIndex + 1,
    },
    turnIndex,
    timestamp,
  }
}

function createFreshDraft(
  toolName: string,
  nowMs: number
): { draft: SessionToolUsageState; turnIndex: number; timestamp: string } {
  const timestamp = new Date(nowMs).toISOString()
  return {
    draft: {
      toolNames: [toolName],
      skillInvocations: [],
      readFiles: [],
      writtenFiles: [],
      events: [{ kind: "tool", value: toolName, turnIndex: 0, timestamp }],
      lastSeen: nowMs,
      nextTurnIndex: 1,
    },
    turnIndex: 0,
    timestamp,
  }
}

function buildInitialDraftUsage(
  existing: SessionToolUsageState | undefined,
  toolName: string,
  nowMs: number
): { draft: SessionToolUsageState; turnIndex: number; timestamp: string } {
  return existing
    ? createDraftFromExisting(existing, toolName, nowMs)
    : createFreshDraft(toolName, nowMs)
}

export function captureSessionToolUsage(
  sessionToolUsage: Map<string, SessionToolUsageState>,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, any> | undefined,
  nowMs: number
): SessionToolUsageState {
  const { draft, turnIndex, timestamp } = buildInitialDraftUsage(
    sessionToolUsage.get(sessionId),
    toolName,
    nowMs
  )

  captureSkillInvocations(draft, toolName, toolInput, turnIndex, timestamp)
  captureFileTargets(draft, toolName, toolInput, turnIndex, timestamp)

  const normalized = normalizeSessionToolUsageState(draft)
  sessionToolUsage.set(sessionId, normalized)
  return normalized
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
