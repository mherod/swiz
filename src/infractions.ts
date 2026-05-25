// ─── Retry-after-block infraction detector ──────────────────────────────────
//
// The advisory context an agent reads (PreToolUse `additionalContext`) is merged
// and run through `humaniseText()` before it reaches the model, so by the time
// the agent sees it the structured directive is gone — it is per-call prose with
// no stable key. That makes "did the agent comply with the message" impossible to
// check after the fact.
//
// What *is* deterministic is the agent's actions. The cleanest machine-detectable
// proxy for "ignored the signal" is RETRY-AFTER-BLOCK: a tool call that a
// PreToolUse hook already DENIED, re-issued unchanged instead of doing the
// required action (CLAUDE.md: "DON'T retry the same command after a hook block").
//
// This module scans the current session transcript, counts how many times the
// action now being attempted was previously denied, and grades the infraction.
// Pure transcript scan — no sentinel files (PreToolUse enforcement must not rely
// on external state per CLAUDE.md).

import { normalizeCommand } from "./command-utils.ts"
import { isCodeChangeTool, isShellTool } from "./tool-matchers.ts"
import { tryParseJsonLine } from "./utils/jsonl.ts"

/**
 * Substrings that appear in the footer of every PreToolUse/Stop denial emitted by
 * `denyPreToolUse` / `blockStop` (see src/utils/hook-utils.ts, blockingStrategy.ts).
 * A tool_result containing one of these was a block, not a normal tool error.
 */
export const DENY_FOOTER_MARKERS = ["You must act on this now", "Resolve this block"] as const

/** Key length cap — mirrors pretooluse-stuck-state.ts so command keys collapse identically. */
const COMMAND_KEY_LENGTH = 60

/** How far back denied attempts count toward an infraction. */
export const INFRACTION_WINDOW_MS = 20 * 60 * 1000

export type InfractionLevel = "none" | "yellow" | "red"

export interface InfractionAssessment {
  level: InfractionLevel
  /** Number of prior denials of the same action within the window. */
  priorDenialCount: number
  /** Normalised key the denials share (command key, file path, or tool name). */
  key: string
  toolName: string
}

interface ToolResultRecord {
  text: string
  timestampMs: number | null
  denied: boolean
}

/** A tool_use whose result was a denial, reduced to a comparable key. */
export interface BlockedAttempt {
  toolName: string
  key: string
  timestampMs: number | null
}

interface CurrentAttempt {
  toolName: string
  key: string
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n")
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  if (typeof record.content === "string") return record.content
  return ""
}

function isDenialText(text: string): boolean {
  return DENY_FOOTER_MARKERS.some((marker) => text.includes(marker))
}

function shellCommandKey(input: Record<string, unknown> | undefined): string {
  const command = String(input?.command ?? input?.cmd ?? "")
  if (!command) return ""
  // Collapse whitespace so retries differing only in spacing still collide —
  // normalizeCommand alone handles backslash-continuations, not internal runs.
  return normalizeCommand(command).replace(/\s+/g, " ").trim().slice(0, COMMAND_KEY_LENGTH)
}

/**
 * Build the comparable key for a tool call. Shell calls key on the (normalised,
 * capped) command; file edits key on the path; anything else keys on the tool name
 * so e.g. repeated denied TaskUpdate attempts still collapse together.
 */
export function attemptKey(toolName: string, input: Record<string, unknown> | undefined): string {
  if (isShellTool(toolName)) return shellCommandKey(input)
  if (isCodeChangeTool(toolName)) return String(input?.file_path ?? input?.path ?? "")
  return toolName
}

/** Minimal typed view of a transcript content block — every field is optional/unknown. */
interface RawBlock {
  type?: unknown
  id?: unknown
  name?: unknown
  tool_use_id?: unknown
  content?: unknown
  timestamp?: unknown
  input?: Record<string, unknown>
}

interface RawEntry {
  type?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
}

/** Return the content-block array of a transcript entry, or null when absent. */
function entryBlocks(line: string): { blocks: RawBlock[]; entry: RawEntry } | null {
  const entry = tryParseJsonLine(line) as RawEntry | undefined
  if (!entry) return null
  const content = entry.message?.content
  return Array.isArray(content) ? { blocks: content as RawBlock[], entry } : null
}

/** Collect tool_result records keyed by their originating tool_use_id. */
function collectResults(lines: string[]): Map<string, ToolResultRecord> {
  const results = new Map<string, ToolResultRecord>()
  for (const line of lines) {
    const parsed = entryBlocks(line)
    if (!parsed) continue
    const entryTimestampMs = parseTimestampMs(parsed.entry.timestamp)
    for (const block of parsed.blocks) {
      if (block?.type !== "tool_result") continue
      const id = String(block.tool_use_id ?? "")
      if (!id) continue
      const text = textFromContent(block.content)
      results.set(id, {
        text,
        timestampMs: parseTimestampMs(block.timestamp) ?? entryTimestampMs,
        denied: isDenialText(text),
      })
    }
  }
  return results
}

/** Build a BlockedAttempt from a tool_use block whose result was a denial, else null. */
function blockedAttemptFromBlock(
  block: RawBlock,
  results: Map<string, ToolResultRecord>,
  entryTimestampMs: number | null
): BlockedAttempt | null {
  if (block?.type !== "tool_use") return null
  const result = results.get(String(block.id ?? ""))
  if (!result?.denied) return null
  const toolName = String(block.name ?? "")
  const key = attemptKey(toolName, block.input)
  if (!key) return null
  return { toolName, key, timestampMs: result.timestampMs ?? entryTimestampMs }
}

/**
 * Scan session lines for tool calls that were denied by a PreToolUse hook,
 * returning one BlockedAttempt per denial in chronological order.
 */
export function collectBlockedAttempts(lines: string[]): BlockedAttempt[] {
  const results = collectResults(lines)
  const attempts: BlockedAttempt[] = []
  for (const line of lines) {
    const parsed = entryBlocks(line)
    if (!parsed || parsed.entry.type !== "assistant") continue
    const entryTimestampMs = parseTimestampMs(parsed.entry.timestamp)
    for (const block of parsed.blocks) {
      const attempt = blockedAttemptFromBlock(block, results, entryTimestampMs)
      if (attempt) attempts.push(attempt)
    }
  }
  return attempts
}

/**
 * Grade the current tool call against prior denials of the same action.
 *
 * Escalation:
 *   - 0 prior denials → "none" (the first block is handled by whichever hook
 *     denied it; this hook does not pile on).
 *   - 1 prior denial  → "yellow" (first retry of a blocked action).
 *   - ≥2 prior denials → "red"   (repeated retry — hard stop).
 */
export function assessInfraction(
  current: CurrentAttempt,
  blockedAttempts: readonly BlockedAttempt[],
  nowMs: number = Date.now(),
  windowMs: number = INFRACTION_WINDOW_MS
): InfractionAssessment {
  const base: InfractionAssessment = {
    level: "none",
    priorDenialCount: 0,
    key: current.key,
    toolName: current.toolName,
  }
  if (!current.key) return base

  const priorDenialCount = blockedAttempts.filter(
    (attempt) =>
      attempt.key === current.key &&
      (attempt.timestampMs === null || nowMs - attempt.timestampMs <= windowMs)
  ).length

  const level: InfractionLevel =
    priorDenialCount >= 2 ? "red" : priorDenialCount === 1 ? "yellow" : "none"

  return { ...base, level, priorDenialCount }
}

/** Resolve the current PreToolUse call into a comparable attempt, or null if it has no key. */
export function resolveCurrentAttempt(input: {
  tool_name?: string
  tool_input?: Record<string, unknown>
}): CurrentAttempt | null {
  const toolName = String(input.tool_name ?? "")
  if (!toolName) return null
  const key = attemptKey(toolName, input.tool_input)
  return key ? { toolName, key } : null
}
