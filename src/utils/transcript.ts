// Transcript parsing utilities for hook scripts.
// Reads Claude Code JSONL transcripts to extract tool calls, commands, and session boundaries.

import {
  extractSessionLines,
  getBashCommandsUsedForCurrentSession,
  getSkillsUsedForCurrentSession,
  getToolsUsedForCurrentSession,
} from "../transcript-summary.ts"
import { extractTextFromUnknownContent } from "../transcript-utils.ts"
import { splitJsonlLines, tryParseJsonLine } from "./jsonl.ts"

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
 * Extract all `tool_use` blocks from a single JSONL transcript line.
 * Returns [] when the line is not an assistant message, is malformed, or has no tool_use blocks.
 * Never throws — malformed JSON is handled via tryParseJsonLine.
 */
export function extractToolBlocksFromEntry(line: string): Array<Record<string, any>> {
  const entry = tryParseJsonLine(line)
  if (entry === undefined || typeof entry !== "object" || Array.isArray(entry)) return []
  const e = entry as Record<string, any>
  if (e?.type !== "assistant") return []
  const message = (e?.message as Record<string, any> | undefined) ?? {}
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block: Record<string, any>) => block?.type === "tool_use")
}

function collectToolBlocksFromLines(lines: string[]): Array<Record<string, any>> {
  const blocks: Array<Record<string, any>> = []
  for (const line of lines) {
    if (!line.trim()) continue
    blocks.push(...extractToolBlocksFromEntry(line))
  }
  return blocks
}

async function readTranscriptToolBlocks(path: string): Promise<Array<Record<string, any>>> {
  const lines = await readSessionLines(path)
  return collectToolBlocksFromLines(lines)
}

// ── Extractors ────────────────────────────────────────────────────────────────

/**
 * Return every tool name used by the assistant in the current session.
 * Returns [] if the file is missing or unreadable.
 */
export async function extractToolNamesFromTranscript(transcriptPath: string): Promise<string[]> {
  return getToolsUsedForCurrentSession(transcriptPath)
}

/**
 * Extract all shell commands from assistant Bash tool_use blocks in the current session.
 */
export async function extractBashCommands(path: string): Promise<string[]> {
  return getBashCommandsUsedForCurrentSession(path)
}

/**
 * Extract the names of all skills invoked via the Skill tool in the current session.
 */
export async function extractSkillInvocations(path: string): Promise<string[]> {
  return getSkillsUsedForCurrentSession(path)
}

/**
 * Extract all file paths from Read tool calls in a transcript.
 * Used to determine which files the agent has already read this session.
 */
export async function extractReadFilePaths(path: string): Promise<Set<string>> {
  const blocks = await readTranscriptToolBlocks(path)
  const paths = new Set<string>()
  for (const block of blocks) {
    if (block.name !== "Read") continue
    const filePath = String((block.input as Record<string, any>)?.file_path ?? "")
    if (filePath) paths.add(filePath)
  }
  return paths
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
    if ((block as Record<string, any>)?.type !== "tool_result") continue
    const text = extractTextFromUnknownContent((block as Record<string, any>).content)
    if (text.includes("ACTION REQUIRED:"))
      ids.push(String((block as Record<string, any>).tool_use_id ?? ""))
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
  try {
    return extractSessionLines(await Bun.file(transcriptPath).text())
  } catch {
    return []
  }
}

/**
 * Read all lines from a transcript JSONL file, ignoring the session boundary.
 * Use when a hook needs to detect patterns that span across sessions/compactions.
 * Returns all non-empty lines.
 */
export async function readAllTranscriptLines(transcriptPath: string): Promise<string[]> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return splitJsonlLines(text)
  } catch {
    return []
  }
}
