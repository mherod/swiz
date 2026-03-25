// Transcript parsing utilities for hook scripts.
// Reads Claude Code JSONL transcripts to extract tool calls, commands, and session boundaries.

import { normalizeCommand } from "../../src/command-utils.ts"
import { isShellTool } from "../../src/tool-matchers.ts"
import { extractTextFromUnknownContent } from "../../src/transcript-utils.ts"

// ── ANSI stripping ────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string so regex pattern matching works on
 * real terminal output (bun test, biome, tsc, etc. embed colour codes).
 * Uses String.fromCharCode(27) to satisfy the no-control-regex lint rule.
 */
const _ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
export function stripAnsi(s: string): string {
  return s.replace(_ANSI_RE, "")
}

// ── Core JSONL reading ────────────────────────────────────────────────────────

/**
 * Read all `tool_use` blocks from assistant messages in a JSONL transcript.
 * Shared by the extract* helpers below.
 */
function extractToolBlocksFromEntry(line: string): Array<Record<string, unknown>> {
  try {
    const entry = JSON.parse(line)
    if (entry?.type !== "assistant") return []
    const content = entry?.message?.content
    if (!Array.isArray(content)) return []
    return content.filter((block: Record<string, unknown>) => block?.type === "tool_use")
  } catch {
    return []
  }
}

function collectToolBlocksFromLines(lines: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const line of lines) {
    if (!line.trim()) continue
    blocks.push(...extractToolBlocksFromEntry(line))
  }
  return blocks
}

function bashCommandsFromBlocks(blocks: Array<Record<string, unknown>>): string[] {
  const commands: string[] = []
  for (const block of blocks) {
    if (!isShellTool(String(block.name ?? ""))) continue
    const cmd = String((block.input as Record<string, unknown>)?.command ?? "")
    if (cmd) commands.push(normalizeCommand(cmd))
  }
  return commands
}

async function readTranscriptToolBlocks(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await Bun.file(path).text()
    return collectToolBlocksFromLines(text.split("\n"))
  } catch {
    return []
  }
}

// ── Extractors ────────────────────────────────────────────────────────────────

/**
 * Parse a Claude Code JSONL transcript and return every tool name called by
 * the assistant, in order. Returns [] if the file is missing or unreadable.
 */
export async function extractToolNamesFromTranscript(transcriptPath: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(transcriptPath)
  return blocks.flatMap((b) => (b.name ? [String(b.name)] : []))
}

/**
 * Extract all shell commands from assistant Bash tool_use blocks in a transcript.
 * Each command is normalised (backslash-newline continuations collapsed).
 */
export async function extractBashCommands(path: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(path)
  return bashCommandsFromBlocks(blocks)
}

/**
 * Extract the names of all skills invoked via the Skill tool in a transcript.
 */
export async function extractSkillInvocations(path: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(path)
  const skills: string[] = []
  for (const block of blocks) {
    if (block.name !== "Skill") continue
    const skill = String((block.input as Record<string, unknown>)?.skill ?? "")
    if (skill) skills.push(skill)
  }
  return skills
}

// ── Blocked tool_use detection ────────────────────────────────────────────────

/**
 * Collect the tool_use IDs of calls denied by a PreToolUse hook.
 *
 * When a PreToolUse hook blocks a tool call, the corresponding tool_result
 * contains the denial reason. All hook denial messages end with the mandatory
 * `ACTION REQUIRED:` footer, which is the reliable detection signal.
 */
function collectBlockedIdsFromContent(content: unknown[]): string[] {
  const ids: string[] = []
  for (const block of content) {
    if ((block as Record<string, unknown>)?.type !== "tool_result") continue
    const text = extractTextFromUnknownContent((block as Record<string, unknown>).content)
    if (text.includes("ACTION REQUIRED:"))
      ids.push(String((block as Record<string, unknown>).tool_use_id ?? ""))
  }
  return ids
}

function extractBlockedIdsFromEntry(line: string): string[] {
  try {
    const entry = JSON.parse(line)
    if (entry?.type !== "user") return []
    const content = entry?.message?.content
    return Array.isArray(content) ? collectBlockedIdsFromContent(content) : []
  } catch {
    return []
  }
}

export function collectBlockedToolUseIds(lines: string[]): Set<string> {
  const blocked = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    for (const id of extractBlockedIdsFromEntry(line)) blocked.add(id)
  }
  return blocked
}

// ── Session boundary detection ────────────────────────────────────────────────

/**
 * Read transcript JSONL and return only the lines that belong to the current
 * session — lines that appear AFTER the last `{"type":"system"}` entry.
 *
 * Claude Code inserts a `{"type":"system"}` entry when resuming from a
 * compacted conversation. Events before that boundary are from prior sessions
 * and must not influence history-dependent hooks.
 *
 * Returns all non-empty lines when no boundary is found.
 */
export async function readSessionLines(transcriptPath: string): Promise<string[]> {
  let text = ""
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return []
  }
  const allLines = text.split("\n")
  let sessionStartIdx = 0
  for (let i = allLines.length - 1; i >= 0; i--) {
    const raw = allLines[i]
    if (!raw?.trim()) continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.type === "system") {
        sessionStartIdx = i + 1
        break
      }
    } catch {
      // ignore malformed lines
    }
  }
  return sessionStartIdx > 0 ? allLines.slice(sessionStartIdx) : allLines
}

/** Signals from the current session transcript for suppressing redundant PreToolUse tips. */
export interface SessionTaskTipContext {
  /** Prior Bash tool_use ran `swiz tasks complete` with `--evidence`. */
  hasSwizCompleteWithEvidence: boolean
  /** Assistant already used TaskList or TaskGet in this session. */
  usedNativeTaskListOrGet: boolean
  /** Prior Bash ran `swiz tasks` add/create/start (lifecycle engagement via CLI). */
  usedSwizTasksAddCreateStart: boolean
}

const NATIVE_TASK_QUERY_TOOLS = new Set(["TaskList", "TaskGet"])

function isSwizCompleteWithEvidenceCommand(normalizedCommand: string): boolean {
  return (
    /swiz\s+tasks\s+complete(?:\s|$)/.test(normalizedCommand) &&
    /--evidence(?:\s|=|$)/.test(normalizedCommand)
  )
}

function isSwizTasksAddCreateOrStartCommand(normalizedCommand: string): boolean {
  return /swiz\s+tasks\s+(?:add|create|start)(?:\s|$)/.test(normalizedCommand)
}

function mergeShellCommandIntoSessionTaskTip(norm: string, acc: SessionTaskTipContext): void {
  if (isSwizCompleteWithEvidenceCommand(norm)) acc.hasSwizCompleteWithEvidence = true
  if (isSwizTasksAddCreateOrStartCommand(norm)) acc.usedSwizTasksAddCreateStart = true
}

function mergeToolBlockIntoSessionTaskTip(
  block: Record<string, unknown>,
  acc: SessionTaskTipContext
): void {
  const name = String(block.name ?? "")
  if (NATIVE_TASK_QUERY_TOOLS.has(name)) acc.usedNativeTaskListOrGet = true
  if (!isShellTool(name)) return
  const raw = String((block.input as Record<string, unknown>)?.command ?? "")
  if (!raw) return
  mergeShellCommandIntoSessionTaskTip(normalizeCommand(raw), acc)
}

function foldBlocksToSessionTaskTip(blocks: Array<Record<string, unknown>>): SessionTaskTipContext {
  const acc: SessionTaskTipContext = {
    hasSwizCompleteWithEvidence: false,
    usedNativeTaskListOrGet: false,
    usedSwizTasksAddCreateStart: false,
  }
  for (const block of blocks) mergeToolBlockIntoSessionTaskTip(block, acc)
  return acc
}

/**
 * Scan the current session (after last compaction boundary) for task-tool patterns
 * that show the agent already follows CLI vs native guidance.
 */
export async function sessionTaskToolPatterns(
  transcriptPath: string
): Promise<SessionTaskTipContext> {
  const empty: SessionTaskTipContext = {
    hasSwizCompleteWithEvidence: false,
    usedNativeTaskListOrGet: false,
    usedSwizTasksAddCreateStart: false,
  }
  if (!transcriptPath) return empty
  const lines = await readSessionLines(transcriptPath)
  return foldBlocksToSessionTaskTip(collectToolBlocksFromLines(lines))
}

/**
 * Read all lines from a transcript JSONL file, ignoring the session boundary.
 * Use when a hook needs to detect patterns that span across sessions/compactions.
 * Returns all non-empty lines.
 */
export async function readAllTranscriptLines(transcriptPath: string): Promise<string[]> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return text.split("\n")
  } catch {
    return []
  }
}
