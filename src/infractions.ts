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

/**
 * Stable phrase embedded in the post-red-card cooldown block so a later scan can
 * tell "this denial was the cooldown we already served" from "this was a real
 * block". Must survive the synonym rephraser — verified by the hook tests.
 */
export const COOLDOWN_MARKER = "cooling off after a hard block"

/**
 * Wanted level, GTA-style: rises with repeated bad behaviour, falls with good.
 *   - none     → ☆0  clear
 *   - yellow   → ★1  first retry of a blocked action (advisory only)
 *   - red      → ★2  repeated retry (hard block)
 *   - cooldown → ★3  the mandatory next-event hold right after a red card
 */
export type InfractionLevel = "none" | "yellow" | "red" | "cooldown"

export const WANTED_LEVEL_BY_INFRACTION: Record<InfractionLevel, number> = {
  none: 0,
  yellow: 1,
  red: 2,
  cooldown: 3,
}

export interface InfractionAssessment {
  level: InfractionLevel
  /** GTA-style wanted level 0–3 derived from `level`. */
  wantedLevel: number
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
  /** True when this denial was our own cooldown hold (carries COOLDOWN_MARKER). */
  isCooldown: boolean
}

/** A tool_use whose result was a denial, reduced to a comparable key. */
export interface BlockedAttempt {
  toolName: string
  key: string
  timestampMs: number | null
  /** True when the denial was our cooldown hold, not a real block. */
  isCooldown: boolean
}

/** The most recent tool call that has a settled result, with how it resolved. */
export interface SettledAttempt {
  key: string
  denied: boolean
  isCooldown: boolean
}

interface CurrentAttempt {
  toolName: string
  key: string
}

function wantedAssessment(
  level: InfractionLevel,
  priorDenialCount: number,
  key: string,
  toolName: string
): InfractionAssessment {
  return { level, wantedLevel: WANTED_LEVEL_BY_INFRACTION[level], priorDenialCount, key, toolName }
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
        isCooldown: text.includes(COOLDOWN_MARKER),
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
  return {
    toolName,
    key,
    timestampMs: result.timestampMs ?? entryTimestampMs,
    isCooldown: result.isCooldown,
  }
}

/**
 * Find the most recent tool call that has a settled result and report how it
 * resolved. Used to decide whether a red-card cooldown is owed (previous event
 * was a real block) or already served (previous event was the cooldown itself).
 */
export function lastSettledAttempt(lines: string[]): SettledAttempt | null {
  const results = collectResults(lines)
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = entryBlocks(lines[i] ?? "")
    if (!parsed || parsed.entry.type !== "assistant") continue
    for (let j = parsed.blocks.length - 1; j >= 0; j--) {
      const block = parsed.blocks[j]
      if (!block || block.type !== "tool_use") continue
      const result = results.get(String(block.id ?? ""))
      if (!result) continue
      const key = attemptKey(String(block.name ?? ""), block.input)
      if (!key) continue
      return { key, denied: result.denied, isCooldown: result.isCooldown }
    }
  }
  return null
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
  if (!current.key) return wantedAssessment("none", 0, current.key, current.toolName)

  // Cooldown holds are our own blocks, not the agent re-issuing a denied action —
  // they must not inflate the retry count.
  const priorDenialCount = blockedAttempts.filter(
    (attempt) =>
      !attempt.isCooldown &&
      attempt.key === current.key &&
      (attempt.timestampMs === null || nowMs - attempt.timestampMs <= windowMs)
  ).length

  const level: InfractionLevel =
    priorDenialCount >= 2 ? "red" : priorDenialCount === 1 ? "yellow" : "none"

  return wantedAssessment(level, priorDenialCount, current.key, current.toolName)
}

const RED_DENIAL_THRESHOLD = 3

/** Count non-cooldown denials of a key inside the window. */
function denialCountForKey(
  key: string,
  blockedAttempts: readonly BlockedAttempt[],
  nowMs: number,
  windowMs: number
): number {
  return blockedAttempts.filter(
    (attempt) =>
      !attempt.isCooldown &&
      attempt.key === key &&
      (attempt.timestampMs === null || nowMs - attempt.timestampMs <= windowMs)
  ).length
}

/**
 * Full wanted-level evaluation for the current call against the whole transcript.
 *
 * Order of precedence:
 *   1. If the current call is itself a repeated retry → yellow/red (assessInfraction).
 *   2. Else if a red card just landed on the previous event (a real block of a
 *      red-level key, not the cooldown) → "cooldown": hold this one event, then
 *      the session may continue.
 *   3. Else de-escalate: a successful previous call, switching to a fresh action,
 *      or an already-served cooldown all leave the wanted level at none.
 */
export function evaluateInfraction(
  lines: string[],
  current: CurrentAttempt,
  nowMs: number = Date.now(),
  windowMs: number = INFRACTION_WINDOW_MS
): InfractionAssessment {
  const blockedAttempts = collectBlockedAttempts(lines)
  const direct = assessInfraction(current, blockedAttempts, nowMs, windowMs)
  // Retrying the same blocked action outranks the cooldown — keep the specific message.
  if (direct.level === "red" || direct.level === "yellow") return direct

  const last = lastSettledAttempt(lines)
  const cooldownDue =
    !!last &&
    last.denied &&
    !last.isCooldown &&
    denialCountForKey(last.key, blockedAttempts, nowMs, windowMs) >= RED_DENIAL_THRESHOLD
  if (cooldownDue) {
    return wantedAssessment("cooldown", direct.priorDenialCount, current.key, current.toolName)
  }

  return direct
}

/**
 * Compliance-derived baseline of the wanted level: unhealthy task governance earns
 * ★1 even before any retry-after-block infraction. Mirrors the governance-healthy
 * rule (≥1 in_progress, ≥1 pending, ≥2 incomplete). Shared by the status line and
 * the daemon snapshot so the baseline is computed identically in both.
 */
export function complianceBaselineWantedLevel(
  counts: { incomplete: number; pending: number; inProgress: number } | null | undefined
): number {
  if (!counts || counts.incomplete <= 0) return 0
  const healthy = counts.inProgress >= 1 && counts.pending >= 1 && counts.incomplete >= 2
  return healthy ? 0 : 1
}

/**
 * Standing wanted level for display (e.g. the status line) — the agent's current
 * "heat" independent of any pending call. Good behaviour clears it: a successful
 * most-recent action, a served cooldown, or no denials all read as level 0.
 * Otherwise it reflects how many times the most-recently-blocked action was denied
 * in the window (1–2 → yellow, ≥3 → red). The transient cooldown tier is not a
 * standing state, so display caps at red.
 */
export function standingWantedLevel(
  lines: string[],
  nowMs: number = Date.now(),
  windowMs: number = INFRACTION_WINDOW_MS
): InfractionAssessment {
  const last = lastSettledAttempt(lines)
  // Last action succeeded / there were none / the cooldown was served → cleared.
  if (!last || !last.denied || last.isCooldown) return wantedAssessment("none", 0, "", "")

  const count = denialCountForKey(last.key, collectBlockedAttempts(lines), nowMs, windowMs)
  const level: InfractionLevel =
    count >= RED_DENIAL_THRESHOLD ? "red" : count >= 1 ? "yellow" : "none"
  return wantedAssessment(level, count, last.key, "")
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
