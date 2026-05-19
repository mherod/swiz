// ─── Transcript summary parser ──────────────────────────────────────────────
//
// Single-pass parser that extracts derived facts from a transcript JSONL file.
// dispatch.ts computes this once per cycle and injects it into hook payloads
// as `_transcriptSummary`. Extracted from hooks/hook-utils.ts (issue #84).

import { normalizeCommand } from "./command-utils.ts"
import {
  extractPathValuesFromToolInput,
  extractSkillNameFromSlashPrompt,
  extractSkillNameFromToolInput,
  extractSkillNamesFromPathValues,
  extractSkillNamesFromShellSkillReadCommand,
  extractSkillNamesFromUserText,
  stripUserQueryWrapper,
} from "./skill-usage.ts"
import { isShellTool, isTaskTool, READ_TOOLS } from "./tool-matchers.ts"
import { readJsonlTailText, splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"
import { gitSubcommandRe } from "./utils/shell-patterns.ts"

/**
 * Session scope classification based on change magnitude and type.
 * Used for governance decisions: what strictness applies to this session?
 */
export type SessionScope = "docs-only" | "trivial" | "small-fix" | "large"

/**
 * Pre-parsed transcript summary injected by dispatch.ts into hook payloads.
 * Hooks should prefer consuming this over re-reading transcript_path.
 */
export interface TranscriptSummary {
  /** Every tool name called by the assistant, in order. */
  toolNames: string[]
  /** Total number of tool_use blocks (same as toolNames.length). */
  toolCallCount: number
  /** Normalized shell commands from Bash/Shell tool calls. */
  bashCommands: string[]
  /** Skill names invoked via the Skill tool. */
  skillInvocations: string[]
  /** Whether any Bash tool call contains `git push`. */
  hasGitPush: boolean
  /**
   * Raw JSONL lines from the current session only (post-compaction boundary).
   * Mirrors the output of readSessionLines() from hook-utils.ts.
   * Hooks that previously called readSessionLines() or Bun.file(transcriptPath).text()
   * should consume this field instead to avoid redundant I/O.
   */
  sessionLines: string[]
  /** Milliseconds elapsed from first to last message in session (0 if single message). */
  sessionDurationMs: number
  /** Count of successful test/build runs detected from bash output patterns. */
  successfulTestRuns: number
  /** ISO timestamp of last successful verification (test/lint/typecheck) or null. */
  lastVerificationTime: string | null
  /** Session scope classification for governance decision-making. */
  sessionScope: SessionScope
}

export const CURRENT_SESSION_USAGE_MAX_TURNS = 30
export const CURRENT_SESSION_USAGE_MAX_AGE_MS = 20 * 60 * 1000

export interface CurrentSessionUsageRecencyOptions {
  maxTurns?: number
  maxAgeMs?: number
  nowMs?: number
}

export type CurrentSessionUsageEventKind = "tool" | "skill" | "bash-command"

export interface CurrentSessionUsageEvent {
  kind: CurrentSessionUsageEventKind
  value: string
  turnIndex: number
  timestamp: string | null
}

/**
 * Lightweight current-session usage data that can be injected by dispatch
 * without requiring a full transcript summary.
 */
export interface CurrentSessionToolUsage {
  toolNames: string[]
  skillInvocations: string[]
  events?: CurrentSessionUsageEvent[]
}

export interface RecentCurrentSessionUsage extends CurrentSessionToolUsage {
  bashCommands: string[]
  events: CurrentSessionUsageEvent[]
}

export interface CurrentSessionTaskToolStats {
  toolNames: string[]
  totalToolCalls: number
  taskToolUsed: boolean
  lastTaskToolCallIndex: number
  callsSinceLastTaskTool: number
}

const GIT_PUSH_PATTERN = gitSubcommandRe("push\\b")

/** Patterns indicating successful test or build runs. */
const SUCCESSFUL_TEST_PATTERNS = [
  /\bpassed\b/i,
  /\bsucceeded?\b/i,
  /\bgreen\b/i,
  /✅.*passed/,
  /all\s+tests?.*passed/i,
  /test\s+run.*success/i,
]

/** Patterns indicating docs-only changes. */
const DOCS_ONLY_PATTERNS = [/\.md$/i, /README/i, /CHANGELOG/i, /docs\//i, /\.mdx$/i]

/** Extract ISO timestamp from transcript JSONL entry. */
function extractTimestamp(line: string): string | null {
  const entry = tryParseJsonLine(line) as { timestamp?: string } | undefined
  return entry?.timestamp ?? null
}

/** Count successful test/build runs in bash output. */
function countSuccessfulTests(bashCommands: string[]): number {
  let count = 0
  for (const cmd of bashCommands) {
    for (const pattern of SUCCESSFUL_TEST_PATTERNS) {
      if (pattern.test(cmd)) {
        count++
        break
      }
    }
  }
  return count
}

/** Classify session scope based on changes and bash commands. */
function classifySessionScope(bashCommands: string[]): SessionScope {
  // Check for docs-only changes
  const docsOnlyCount = bashCommands.filter((cmd) =>
    DOCS_ONLY_PATTERNS.some((p) => p.test(cmd))
  ).length

  const totalRelevant = bashCommands.length
  if (docsOnlyCount === totalRelevant) return "docs-only"

  // Check for test-heavy sessions (many successful test runs)
  const testCount = countSuccessfulTests(bashCommands)
  if (testCount >= 5) return "large"
  if (testCount >= 2) return "small-fix"

  // Check for edit-heavy sessions
  const editCommands = bashCommands.filter((cmd) =>
    /edit|commit|add|write|modify/i.test(cmd)
  ).length

  if (editCommands <= 2) return "trivial"
  if (editCommands <= 5) return "small-fix"
  return "large"
}

/**
 * Extract session-boundary-aware lines from a full transcript text.
 * Mirrors readSessionLines() in hook-utils.ts: returns only lines after the
 * last {"type":"system"} entry (i.e. post-compaction) so pre-session content
 * is excluded from hook checks.
 */
export function extractSessionLines(jsonlText: string): string[] {
  const allLines = splitJsonlLines(jsonlText)
  return filterSessionLines(allLines).sessionLines
}

/**
 * Filter an array of JSONL lines to return only those after the last compaction boundary.
 */
function filterSessionLines(allLines: string[]): { sessionLines: string[]; sawSystem: boolean } {
  let sessionStartIdx = 0
  for (let i = allLines.length - 1; i >= 0; i--) {
    const raw = allLines[i]
    if (!raw?.trim()) continue
    const parsed = tryParseJsonLine(raw) as { type?: string } | undefined
    if (parsed?.type === "system") {
      sessionStartIdx = i + 1
      break
    }
  }
  return {
    sessionLines: sessionStartIdx > 0 ? allLines.slice(sessionStartIdx) : allLines,
    sawSystem: sessionStartIdx > 0,
  }
}

export async function readCurrentSessionLines(transcriptPath: string): Promise<string[] | null> {
  let sessionLines: string[] = []
  const result = await readJsonlTailText(transcriptPath, {
    isEnough: (text, meta) => {
      const filtered = filterSessionLines(splitJsonlLines(text))
      sessionLines = filtered.sessionLines
      return filtered.sawSystem || meta.reachedStart
    },
  })
  return result ? sessionLines : null
}

/**
 * Parse a transcript JSONL string in a single pass and extract all derived
 * facts that hooks need. Returns a TranscriptSummary.
 */
interface ToolBlock {
  type?: string
  name?: string
  input?: {
    command?: string
    cmd?: string
    file_path?: string
    path?: string
    paths?: string[]
    skill?: string
  }
}

interface CodexFunctionCallPayload {
  type?: string
  name?: string
  arguments?: string | ToolBlock["input"]
}

function parseCodexFunctionCallInput(
  rawArguments: CodexFunctionCallPayload["arguments"]
): ToolBlock["input"] {
  if (!rawArguments) return undefined
  if (typeof rawArguments !== "string") return rawArguments
  try {
    const parsed = JSON.parse(rawArguments) as ToolBlock["input"]
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseAssistantToolBlocks(line: string): ToolBlock[] {
  const entry = tryParseJsonLine(line) as
    | {
        type?: string
        message?: { content?: ToolBlock[] }
        payload?: CodexFunctionCallPayload
      }
    | undefined
  if (entry?.type === "assistant") {
    const content = entry?.message?.content
    return Array.isArray(content) ? content : []
  }

  const payload = entry?.payload
  if (entry?.type === "response_item" && payload?.type === "function_call" && payload.name) {
    return [
      {
        type: "tool_use",
        name: payload.name,
        input: parseCodexFunctionCallInput(payload.arguments),
      },
    ]
  }

  return []
}

interface SummaryAccumulator {
  toolNames: string[]
  bashCommands: string[]
  skillInvocations: string[]
  hasGitPush: boolean
  firstTimestamp: string | null
  lastTimestamp: string | null
}

function createEmptySummaryAccumulator(): SummaryAccumulator {
  return {
    toolNames: [],
    bashCommands: [],
    skillInvocations: [],
    hasGitPush: false,
    firstTimestamp: null,
    lastTimestamp: null,
  }
}

function extractToolName(block: ToolBlock): string {
  return block?.name ?? ""
}

function extractShellCommand(block: ToolBlock, name: string): string {
  return isShellTool(name) ? (block?.input?.command ?? block?.input?.cmd ?? "") : ""
}

function accumulateShellCommand(block: ToolBlock, name: string, acc: SummaryAccumulator): void {
  const cmd = extractShellCommand(block, name)
  if (!cmd) return
  acc.bashCommands.push(normalizeCommand(cmd))
  if (!acc.hasGitPush && GIT_PUSH_PATTERN.test(cmd)) acc.hasGitPush = true
}

function extractDirectSkillReadInvocations(block: ToolBlock, name: string): string[] {
  if (READ_TOOLS.has(name)) {
    return extractSkillNamesFromPathValues(extractPathValuesFromToolInput(block.input))
  }

  if (!isShellTool(name)) return []
  const command = normalizeCommand(extractShellCommand(block, name)).trim()
  return extractSkillNamesFromShellSkillReadCommand(command)
}

function appendSkillInvocations(skills: string[], acc: SummaryAccumulator): void {
  for (const skill of skills) {
    if (!acc.skillInvocations.includes(skill)) acc.skillInvocations.push(skill)
  }
}

function processToolBlock(block: ToolBlock, acc: SummaryAccumulator): void {
  if (block?.type !== "tool_use") return
  const name = extractToolName(block)
  if (!name) return
  acc.toolNames.push(name)
  accumulateShellCommand(block, name, acc)
  if (name === "Skill") {
    const skill = extractSkillNameFromToolInput(block.input)
    if (skill) acc.skillInvocations.push(skill)
  }
  appendSkillInvocations(extractDirectSkillReadInvocations(block, name), acc)
}

function collectShellCommandUsageEvents(
  block: ToolBlock,
  name: string,
  turnIndex: number,
  timestamp: string | null
): CurrentSessionUsageEvent[] {
  const command = extractShellCommand(block, name)
  if (!command) return []
  return [
    {
      kind: "bash-command",
      value: normalizeCommand(command),
      turnIndex,
      timestamp,
    },
  ]
}

function collectSkillUsageEventsFromBlock(
  block: ToolBlock,
  name: string,
  turnIndex: number,
  timestamp: string | null
): CurrentSessionUsageEvent[] {
  const skills = new Set<string>()
  if (name === "Skill") {
    const skill = extractSkillNameFromToolInput(block.input)
    if (skill) skills.add(skill)
  }
  for (const skill of extractDirectSkillReadInvocations(block, name)) skills.add(skill)
  return [...skills].map((value) => ({ kind: "skill", value, turnIndex, timestamp }))
}

function collectToolUsageEventsFromBlock(
  block: ToolBlock,
  turnIndex: number,
  timestamp: string | null
): CurrentSessionUsageEvent[] {
  if (block?.type !== "tool_use") return []
  const name = extractToolName(block)
  if (!name) return []

  const events: CurrentSessionUsageEvent[] = [{ kind: "tool", value: name, turnIndex, timestamp }]
  events.push(...collectShellCommandUsageEvents(block, name, turnIndex, timestamp))
  events.push(...collectSkillUsageEventsFromBlock(block, name, turnIndex, timestamp))
  return events
}

interface UserMessageContentBlock {
  type?: string
  text?: string
}

interface ParsedTranscriptEntry {
  type?: string
  operation?: string
  content?: string | UserMessageContentBlock[]
  message?: { content?: string | UserMessageContentBlock[] }
  payload?: {
    type?: string
    role?: string
    content?: string | UserMessageContentBlock[]
  }
  attachment?: { type?: string; prompt?: string }
}

function extractTextFromUserMessage(
  content: string | UserMessageContentBlock[] | undefined
): string {
  if (typeof content === "string") return stripUserQueryWrapper(content)
  if (!Array.isArray(content)) return ""
  return stripUserQueryWrapper(
    content
      .filter((b) => b?.type === "text" || b?.type === "input_text")
      .map((b) => b.text ?? "")
      .join("")
  )
}

function extractUserEntryText(entry: ParsedTranscriptEntry): string {
  const texts = [
    extractTextFromUserMessage(entry.message?.content),
    extractTextFromUserMessage(entry.content),
  ].filter(Boolean)
  return texts.join("\n")
}

function extractUserSkillExpansions(line: string): string[] {
  const entry = tryParseJsonLine(line) as ParsedTranscriptEntry | undefined
  if (!entry) return []

  // Newer Claude Code records user-typed slash commands as queue-operation
  // entries with a leading-slash prompt in their content field.
  if (entry.type === "queue-operation" && entry.operation === "enqueue") {
    const text = extractTextFromUserMessage(entry.content)
    const skill = extractSkillNameFromSlashPrompt(text)
    return skill ? [skill] : []
  }

  // The same prompt is also persisted as an attachment of type queued_command.
  if (entry.type === "attachment" && entry.attachment?.type === "queued_command") {
    const skill = extractSkillNameFromSlashPrompt(entry.attachment.prompt)
    return skill ? [skill] : []
  }

  if (entry.type === "response_item" && entry.payload?.type === "message") {
    if (entry.payload.role !== "user") return []
    const text = extractTextFromUserMessage(entry.payload.content)
    const skill = extractSkillNameFromSlashPrompt(text)
    return skill ? [skill] : []
  }

  // Skill content injected after the slash command resolves shows up in user
  // messages with the activation banner and the legacy command-name tag (older
  // Claude Code versions). Detect both so the gate works across formats.
  if (entry.type === "user" || entry.type === "human") {
    const text = extractUserEntryText(entry)
    return extractSkillNamesFromUserText(text)
  }

  return []
}

export function collectSessionToolUsage(
  sessionLines: string[],
  acc: SummaryAccumulator = createEmptySummaryAccumulator()
): SummaryAccumulator {
  for (const line of sessionLines) {
    if (!line.trim()) continue
    for (const block of parseAssistantToolBlocks(line)) {
      processToolBlock(block, acc)
    }
    appendSkillInvocations(extractUserSkillExpansions(line), acc)
    const ts = extractTimestamp(line)
    if (ts) {
      if (!acc.firstTimestamp) acc.firstTimestamp = ts
      acc.lastTimestamp = ts
    }
  }
  return acc
}

export function collectCurrentSessionUsageEvents(
  sessionLines: string[]
): CurrentSessionUsageEvent[] {
  const events: CurrentSessionUsageEvent[] = []
  let turnIndex = 0
  for (let i = 0; i < sessionLines.length; i++) {
    const line = sessionLines[i] ?? ""
    if (!line.trim()) continue
    const entry = tryParseJsonLine(line) as { type?: string } | undefined
    // Treat each user/human message as a new turn so the turn-based recency
    // window means "last N user turns" rather than "last N raw JSONL lines"
    // (attachments, ai-title, and queue-operation entries shouldn't burn turns).
    if (entry?.type === "user" || entry?.type === "human") turnIndex++
    const timestamp = extractTimestamp(line)
    for (const block of parseAssistantToolBlocks(line)) {
      events.push(...collectToolUsageEventsFromBlock(block, turnIndex, timestamp))
    }
    for (const skill of extractUserSkillExpansions(line)) {
      events.push({ kind: "skill", value: skill, turnIndex, timestamp })
    }
  }
  return events
}

function resolveUsageRecencyOptions(
  options: CurrentSessionUsageRecencyOptions = {}
): Required<CurrentSessionUsageRecencyOptions> {
  return {
    maxTurns: options.maxTurns ?? CURRENT_SESSION_USAGE_MAX_TURNS,
    maxAgeMs: options.maxAgeMs ?? CURRENT_SESSION_USAGE_MAX_AGE_MS,
    nowMs: options.nowMs ?? Date.now(),
  }
}

function isTimestampWithinWindow(
  timestamp: string | null,
  nowMs: number,
  maxAgeMs: number
): boolean {
  if (maxAgeMs < 0) return true
  if (!timestamp) return false
  const eventMs = Date.parse(timestamp)
  if (!Number.isFinite(eventMs)) return false
  return nowMs - eventMs <= maxAgeMs
}

export function filterRecentCurrentSessionUsageEvents(
  sessionLines: string[],
  options: CurrentSessionUsageRecencyOptions = {}
): CurrentSessionUsageEvent[] {
  const events = collectCurrentSessionUsageEvents(sessionLines)
  if (events.length === 0) return []

  // turnIndex now counts user/human messages, not raw line positions; the last
  // event's turnIndex is the freshest "current turn" reference for windowing.
  const lastTurnIndex = events.reduce((acc, event) => Math.max(acc, event.turnIndex), 0)
  return filterRecentUsageEvents(events, lastTurnIndex, options)
}

function filterRecentUsageEvents(
  events: CurrentSessionUsageEvent[],
  lastTurnIndex: number,
  options: CurrentSessionUsageRecencyOptions = {}
): CurrentSessionUsageEvent[] {
  const { maxTurns, maxAgeMs, nowMs } = resolveUsageRecencyOptions(options)
  const firstAllowedTurnIndex = Math.max(0, lastTurnIndex - maxTurns + 1)
  return events.filter(
    (event) =>
      event.turnIndex >= firstAllowedTurnIndex &&
      isTimestampWithinWindow(event.timestamp, nowMs, maxAgeMs)
  )
}

function usageFromEvents(events: CurrentSessionUsageEvent[]): RecentCurrentSessionUsage {
  return {
    toolNames: events.filter((event) => event.kind === "tool").map((event) => event.value),
    skillInvocations: events.filter((event) => event.kind === "skill").map((event) => event.value),
    bashCommands: events
      .filter((event) => event.kind === "bash-command")
      .map((event) => event.value),
    events,
  }
}

async function readRecentSessionUsage(
  transcriptPath: string,
  options?: CurrentSessionUsageRecencyOptions
): Promise<RecentCurrentSessionUsage> {
  return (await tryReadRecentSessionUsage(transcriptPath, options)) ?? usageFromEvents([])
}

async function tryReadRecentSessionUsage(
  transcriptPath: string,
  options?: CurrentSessionUsageRecencyOptions
): Promise<RecentCurrentSessionUsage | null> {
  try {
    const sessionLines = await readCurrentSessionLines(transcriptPath)
    if (!sessionLines) return null
    return usageFromEvents(filterRecentCurrentSessionUsageEvents(sessionLines, options))
  } catch {
    return null
  }
}

async function readSessionToolUsage(transcriptPath: string): Promise<SummaryAccumulator> {
  try {
    const sessionLines = await readCurrentSessionLines(transcriptPath)
    return sessionLines ? collectSessionToolUsage(sessionLines) : createEmptySummaryAccumulator()
  } catch {
    return createEmptySummaryAccumulator()
  }
}

function transcriptPathFromUsageSource(source: string | Record<string, any>): string {
  if (typeof source === "string") return source
  return typeof source.transcript_path === "string" ? source.transcript_path : ""
}

function isCurrentSessionUsageEvent(value: unknown): value is CurrentSessionUsageEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Record<string, unknown>
  return (
    (event.kind === "tool" || event.kind === "skill" || event.kind === "bash-command") &&
    typeof event.value === "string" &&
    typeof event.turnIndex === "number" &&
    (typeof event.timestamp === "string" || event.timestamp === null)
  )
}

export function getCurrentSessionToolUsage(
  input: Record<string, any>
): CurrentSessionToolUsage | null {
  const usage = input?._currentSessionToolUsage
  if (usage && typeof usage === "object") {
    const candidate = usage as Record<string, any>
    if (Array.isArray(candidate.toolNames) && Array.isArray(candidate.skillInvocations)) {
      return {
        toolNames: candidate.toolNames.filter((v): v is string => typeof v === "string"),
        skillInvocations: candidate.skillInvocations.filter(
          (v): v is string => typeof v === "string"
        ),
        events: Array.isArray(candidate.events)
          ? candidate.events.filter(isCurrentSessionUsageEvent)
          : undefined,
      }
    }
  }

  const summary = getTranscriptSummary(input)
  return summary
    ? {
        toolNames: summary.toolNames,
        skillInvocations: summary.skillInvocations,
        events: collectCurrentSessionUsageEvents(summary.sessionLines),
      }
    : null
}

export function findLastTaskToolCallIndex(toolNames: string[]): number {
  for (let i = toolNames.length - 1; i >= 0; i--) {
    const name = toolNames[i]
    if (name && isTaskTool(name)) return i
  }
  return -1
}

export function deriveCurrentSessionTaskToolStats(
  toolNames: string[]
): CurrentSessionTaskToolStats {
  const totalToolCalls = toolNames.length
  const lastTaskToolCallIndex = findLastTaskToolCallIndex(toolNames)
  return {
    toolNames,
    totalToolCalls,
    taskToolUsed: lastTaskToolCallIndex >= 0,
    lastTaskToolCallIndex,
    callsSinceLastTaskTool:
      lastTaskToolCallIndex >= 0 ? totalToolCalls - 1 - lastTaskToolCallIndex : totalToolCalls,
  }
}

/**
 * Read the current session transcript and return every assistant tool name in order.
 * Only lines after the last compaction boundary are considered.
 */
export async function getToolsUsedForCurrentSession(
  source: string | Record<string, any>
): Promise<string[]> {
  if (typeof source !== "string") {
    const usage = getCurrentSessionToolUsage(source)
    if (usage) return usage.toolNames
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? (await readSessionToolUsage(transcriptPath)).toolNames : []
}

export async function getRecentCurrentSessionUsage(
  source: string | Record<string, any>,
  options?: CurrentSessionUsageRecencyOptions
): Promise<RecentCurrentSessionUsage> {
  if (typeof source !== "string") {
    const summary = getTranscriptSummary(source)
    const transcriptPath = transcriptPathFromUsageSource(source)
    const transcriptUsage = transcriptPath
      ? await tryReadRecentSessionUsage(transcriptPath, options)
      : null
    const summaryEvents = summary
      ? filterRecentCurrentSessionUsageEvents(summary.sessionLines, options)
      : []
    const cachedUsage = getCurrentSessionToolUsage(source)
    const cachedEvents = cachedUsage?.events
      ? filterRecentUsageEvents(
          cachedUsage.events,
          cachedUsage.events.length > 0
            ? Math.max(...cachedUsage.events.map((event) => event.turnIndex))
            : 0,
          options
        )
      : []
    if (summaryEvents.length > 0 || transcriptUsage || cachedEvents.length > 0) {
      // Merge transcript and daemon-cache events so both user-typed `/skill`
      // expansions (visible only in the transcript) and agent-invoked tool calls
      // captured by the daemon are surfaced to recency gates.
      return usageFromEvents(
        mergeUsageEvents(
          mergeUsageEvents(summaryEvents, transcriptUsage?.events ?? []),
          cachedEvents
        )
      )
    }
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? readRecentSessionUsage(transcriptPath, options) : usageFromEvents([])
}

function mergeUsageEvents(
  primary: CurrentSessionUsageEvent[],
  secondary: CurrentSessionUsageEvent[]
): CurrentSessionUsageEvent[] {
  if (secondary.length === 0 && primary.length === 0) return primary
  const merged: CurrentSessionUsageEvent[] = []
  const seenSkills = new Set<string>()
  const seenToolish = new Set<string>()
  for (const event of [...primary, ...secondary]) {
    if (event.kind === "skill") {
      if (seenSkills.has(event.value)) continue
      seenSkills.add(event.value)
      merged.push(event)
      continue
    }
    const key = `${event.kind}|${event.value}|${event.turnIndex}`
    if (seenToolish.has(key)) continue
    seenToolish.add(key)
    merged.push(event)
  }
  return merged
}

export async function getRecentToolsUsedForCurrentSession(
  source: string | Record<string, any>,
  options?: CurrentSessionUsageRecencyOptions
): Promise<string[]> {
  return (await getRecentCurrentSessionUsage(source, options)).toolNames
}

/**
 * Read the current session transcript and return every skill invoked via the Skill tool.
 * Only lines after the last compaction boundary are considered.
 */
export async function getSkillsUsedForCurrentSession(
  source: string | Record<string, any>
): Promise<string[]> {
  if (typeof source !== "string") {
    const usage = getCurrentSessionToolUsage(source)
    if (usage) return usage.skillInvocations
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? (await readSessionToolUsage(transcriptPath)).skillInvocations : []
}

export async function getRecentSkillsUsedForCurrentSession(
  source: string | Record<string, any>,
  options?: CurrentSessionUsageRecencyOptions
): Promise<string[]> {
  return (await getRecentCurrentSessionUsage(source, options)).skillInvocations
}

export async function getCurrentSessionTaskToolStats(
  source: string | Record<string, any>
): Promise<CurrentSessionTaskToolStats> {
  return deriveCurrentSessionTaskToolStats(await getToolsUsedForCurrentSession(source))
}

/**
 * Read the current session transcript and return normalised Bash/Shell commands.
 * Only lines after the last compaction boundary are considered.
 */
export async function getBashCommandsUsedForCurrentSession(
  transcriptPath: string
): Promise<string[]> {
  return (await readSessionToolUsage(transcriptPath)).bashCommands
}

export async function getRecentBashCommandsUsedForCurrentSession(
  source: string | Record<string, any>,
  options?: CurrentSessionUsageRecencyOptions
): Promise<string[]> {
  return (await getRecentCurrentSessionUsage(source, options)).bashCommands
}

export function formatCurrentSessionUsageWindow(
  options: CurrentSessionUsageRecencyOptions = {}
): string {
  const { maxTurns, maxAgeMs } = resolveUsageRecencyOptions(options)
  return `last ${maxTurns} turns and last ${Math.floor(maxAgeMs / 60000)} minutes`
}

export function parseTranscriptSummary(jsonlText: string): TranscriptSummary {
  const sessionLines = extractSessionLines(jsonlText)
  return computeSummaryFromSessionLines(sessionLines)
}

/**
 * Compute transcript summary from already-filtered session lines.
 */
export function computeSummaryFromSessionLines(
  sessionLines: string[],
  acc: SummaryAccumulator = collectSessionToolUsage(sessionLines)
): TranscriptSummary {
  const successfulTestRuns = countSuccessfulTests(acc.bashCommands)
  const sessionScope = classifySessionScope(acc.bashCommands)

  let sessionDurationMs = 0
  if (acc.firstTimestamp && acc.lastTimestamp) {
    try {
      const firstMs = new Date(acc.firstTimestamp).getTime()
      const lastMs = new Date(acc.lastTimestamp).getTime()
      sessionDurationMs = Math.max(0, lastMs - firstMs)
    } catch {}
  }

  return {
    ...acc,
    toolCallCount: acc.toolNames.length,
    sessionLines,
    sessionDurationMs,
    successfulTestRuns,
    lastVerificationTime: acc.lastTimestamp,
    sessionScope,
  }
}

/**
 * Read a transcript file and compute the summary. Returns null if the file
 * is missing or unreadable.
 */
export async function computeTranscriptSummary(
  transcriptPath: string
): Promise<TranscriptSummary | null> {
  try {
    const sessionLines = await readCurrentSessionLines(transcriptPath)
    return sessionLines ? computeSummaryFromSessionLines(sessionLines) : null
  } catch {
    return null
  }
}

/**
 * Extract the TranscriptSummary from a hook input payload (injected by dispatch).
 * Returns null if the summary is not present.
 */
export function getTranscriptSummary(input: Record<string, any>): TranscriptSummary | null {
  const summary = input?._transcriptSummary
  if (!summary || typeof summary !== "object") return null
  const s = summary as Record<string, any>
  if (!Array.isArray(s.toolNames)) return null
  return summary as TranscriptSummary
}
