// ─── Transcript summary parser ──────────────────────────────────────────────
//
// Single-pass parser that extracts derived facts from a transcript JSONL file.
// dispatch.ts computes this once per cycle and injects it into hook payloads
// as `_transcriptSummary`. Extracted from hooks/hook-utils.ts (issue #84).

import { normalizeCommand } from "./command-utils.ts"
import { isShellTool, isTaskTool } from "./tool-matchers.ts"
import { splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"
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

export const CURRENT_SESSION_USAGE_MAX_TURNS = 20
export const CURRENT_SESSION_USAGE_MAX_AGE_MS = 10 * 60 * 1000

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
  return filterSessionLines(allLines)
}

/**
 * Filter an array of JSONL lines to return only those after the last compaction boundary.
 */
function filterSessionLines(allLines: string[]): string[] {
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
  return sessionStartIdx > 0 ? allLines.slice(sessionStartIdx) : allLines
}

/**
 * Parse a transcript JSONL string in a single pass and extract all derived
 * facts that hooks need. Returns a TranscriptSummary.
 */
interface ToolBlock {
  type?: string
  name?: string
  input?: { command?: string; skill?: string }
}

function parseAssistantToolBlocks(line: string): ToolBlock[] {
  const entry = tryParseJsonLine(line) as
    | {
        type?: string
        message?: { content?: ToolBlock[] }
      }
    | undefined
  if (entry?.type !== "assistant") return []
  const content = entry?.message?.content
  return Array.isArray(content) ? content : []
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
  return isShellTool(name) ? (block?.input?.command ?? "") : ""
}

function accumulateShellCommand(block: ToolBlock, name: string, acc: SummaryAccumulator): void {
  const cmd = extractShellCommand(block, name)
  if (!cmd) return
  acc.bashCommands.push(normalizeCommand(cmd))
  if (!acc.hasGitPush && GIT_PUSH_PATTERN.test(cmd)) acc.hasGitPush = true
}

function processToolBlock(block: ToolBlock, acc: SummaryAccumulator): void {
  if (block?.type !== "tool_use") return
  const name = extractToolName(block)
  if (!name) return
  acc.toolNames.push(name)
  accumulateShellCommand(block, name, acc)
  if (name === "Skill") {
    const skill = block?.input?.skill ?? ""
    if (skill) acc.skillInvocations.push(skill)
  }
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
  const command = extractShellCommand(block, name)
  if (command) {
    events.push({
      kind: "bash-command",
      value: normalizeCommand(command),
      turnIndex,
      timestamp,
    })
  }
  if (name === "Skill") {
    const skill = block?.input?.skill ?? ""
    if (skill) events.push({ kind: "skill", value: skill, turnIndex, timestamp })
  }
  return events
}

/** Match `<command-name>skill-name</command-name>` tags in user messages (skill expansion). */
const COMMAND_NAME_RE = /<command-name>([a-z][a-z0-9-]*)<\/command-name>/g

function extractUserSkillExpansions(line: string): string[] {
  const entry = tryParseJsonLine(line) as
    | { type?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }
    | undefined
  if (entry?.type !== "human") return []
  const content = entry?.message?.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : ""
  if (!text) return []
  const skills: string[] = []
  for (const match of text.matchAll(COMMAND_NAME_RE)) {
    if (match[1]) skills.push(match[1])
  }
  return skills
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
    for (const skill of extractUserSkillExpansions(line)) {
      if (!acc.skillInvocations.includes(skill)) {
        acc.skillInvocations.push(skill)
      }
    }
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
  for (let turnIndex = 0; turnIndex < sessionLines.length; turnIndex++) {
    const line = sessionLines[turnIndex] ?? ""
    if (!line.trim()) continue
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

  const lastTurnIndex = Math.max(0, sessionLines.length - 1)
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
    const text = await Bun.file(transcriptPath).text()
    return usageFromEvents(
      filterRecentCurrentSessionUsageEvents(extractSessionLines(text), options)
    )
  } catch {
    return null
  }
}

async function readSessionToolUsage(transcriptPath: string): Promise<SummaryAccumulator> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return collectSessionToolUsage(extractSessionLines(text))
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
    if (summary) {
      return usageFromEvents(filterRecentCurrentSessionUsageEvents(summary.sessionLines, options))
    }
    const transcriptPath = transcriptPathFromUsageSource(source)
    if (transcriptPath) {
      const transcriptUsage = await tryReadRecentSessionUsage(transcriptPath, options)
      if (transcriptUsage) return transcriptUsage
    }
    const usage = getCurrentSessionToolUsage(source)
    if (usage?.events) {
      const lastTurnIndex =
        usage.events.length > 0 ? Math.max(...usage.events.map((event) => event.turnIndex)) : 0
      return usageFromEvents(filterRecentUsageEvents(usage.events, lastTurnIndex, options))
    }
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? readRecentSessionUsage(transcriptPath, options) : usageFromEvents([])
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
    const text = await Bun.file(transcriptPath).text()
    return parseTranscriptSummary(text)
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
