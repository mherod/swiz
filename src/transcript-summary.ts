// ─── Transcript summary parser ──────────────────────────────────────────────
//
// Single-pass parser that extracts derived facts from a transcript JSONL file.
// dispatch.ts computes this once per cycle and injects it into hook payloads
// as `_transcriptSummary`. Extracted from hooks/hook-utils.ts (issue #84).

import { normalizeCommand } from "./command-utils.ts"
import { isShellTool, isTaskTool } from "./tool-matchers.ts"
import { tryParseJsonLine } from "./utils/jsonl.ts"
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

/**
 * Lightweight current-session usage data that can be injected by dispatch
 * without requiring a full transcript summary.
 */
export interface CurrentSessionToolUsage {
  toolNames: string[]
  skillInvocations: string[]
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
  try {
    const entry = JSON.parse(line) as { timestamp?: string }
    return entry?.timestamp ?? null
  } catch {
    return null
  }
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

/** Extract the last successful verification timestamp from session lines. */
function extractLastVerificationTime(sessionLines: string[]): string | null {
  for (let i = sessionLines.length - 1; i >= 0; i--) {
    const timestamp = extractTimestamp(sessionLines[i]!)
    if (timestamp) return timestamp
  }
  return null
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

/** Compute session duration from timestamps in session lines. */
function computeSessionDuration(sessionLines: string[]): number {
  const firstTime = extractTimestamp(sessionLines[0] ?? "")
  const lastTime = extractTimestamp(sessionLines[sessionLines.length - 1] ?? "")

  if (!firstTime || !lastTime) return 0

  try {
    const firstMs = new Date(firstTime).getTime()
    const lastMs = new Date(lastTime).getTime()
    return Math.max(0, lastMs - firstMs)
  } catch {
    return 0
  }
}

/**
 * Extract session-boundary-aware lines from a full transcript text.
 * Mirrors readSessionLines() in hook-utils.ts: returns only lines after the
 * last {"type":"system"} entry (i.e. post-compaction) so pre-session content
 * is excluded from hook checks.
 */
export function extractSessionLines(jsonlText: string): string[] {
  const allLines = jsonlText.split("\n")
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
}

function createEmptySummaryAccumulator(): SummaryAccumulator {
  return {
    toolNames: [],
    bashCommands: [],
    skillInvocations: [],
    hasGitPush: false,
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

function collectSessionToolUsage(sessionLines: string[]): SummaryAccumulator {
  const acc = createEmptySummaryAccumulator()
  for (const line of sessionLines) {
    if (!line.trim()) continue
    for (const block of parseAssistantToolBlocks(line)) {
      processToolBlock(block, acc)
    }
  }
  return acc
}

async function readSessionToolUsage(transcriptPath: string): Promise<SummaryAccumulator> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return collectSessionToolUsage(extractSessionLines(text))
  } catch {
    return createEmptySummaryAccumulator()
  }
}

function transcriptPathFromUsageSource(source: string | Record<string, unknown>): string {
  if (typeof source === "string") return source
  return typeof source.transcript_path === "string" ? source.transcript_path : ""
}

export function getCurrentSessionToolUsage(
  input: Record<string, unknown>
): CurrentSessionToolUsage | null {
  const usage = input?._currentSessionToolUsage
  if (usage && typeof usage === "object") {
    const candidate = usage as Record<string, unknown>
    if (Array.isArray(candidate.toolNames) && Array.isArray(candidate.skillInvocations)) {
      return {
        toolNames: candidate.toolNames.filter((v): v is string => typeof v === "string"),
        skillInvocations: candidate.skillInvocations.filter(
          (v): v is string => typeof v === "string"
        ),
      }
    }
  }

  const summary = getTranscriptSummary(input)
  return summary
    ? {
        toolNames: summary.toolNames,
        skillInvocations: summary.skillInvocations,
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
  source: string | Record<string, unknown>
): Promise<string[]> {
  if (typeof source !== "string") {
    const usage = getCurrentSessionToolUsage(source)
    if (usage) return usage.toolNames
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? (await readSessionToolUsage(transcriptPath)).toolNames : []
}

/**
 * Read the current session transcript and return every skill invoked via the Skill tool.
 * Only lines after the last compaction boundary are considered.
 */
export async function getSkillsUsedForCurrentSession(
  source: string | Record<string, unknown>
): Promise<string[]> {
  if (typeof source !== "string") {
    const usage = getCurrentSessionToolUsage(source)
    if (usage) return usage.skillInvocations
  }
  const transcriptPath = transcriptPathFromUsageSource(source)
  return transcriptPath ? (await readSessionToolUsage(transcriptPath)).skillInvocations : []
}

export async function getCurrentSessionTaskToolStats(
  source: string | Record<string, unknown>
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

export function parseTranscriptSummary(jsonlText: string): TranscriptSummary {
  const sessionLines = extractSessionLines(jsonlText)
  const acc = collectSessionToolUsage(sessionLines)

  const sessionDurationMs = computeSessionDuration(sessionLines)
  const successfulTestRuns = countSuccessfulTests(acc.bashCommands)
  const lastVerificationTime = extractLastVerificationTime(sessionLines)
  const sessionScope = classifySessionScope(acc.bashCommands)

  return {
    ...acc,
    toolCallCount: acc.toolNames.length,
    sessionLines,
    sessionDurationMs,
    successfulTestRuns,
    lastVerificationTime,
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
export function getTranscriptSummary(input: Record<string, unknown>): TranscriptSummary | null {
  const summary = input?._transcriptSummary
  if (!summary || typeof summary !== "object") return null
  const s = summary as Record<string, unknown>
  if (!Array.isArray(s.toolNames)) return null
  return summary as TranscriptSummary
}
