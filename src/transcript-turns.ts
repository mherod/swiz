import { LRUCache } from "lru-cache"
import type { DisplayTurn } from "../scripts/transcript/monitor-state.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import type { TimeRange, TranscriptArgs } from "./transcript-args.ts"
import { type DebugEvent, loadDebugLog, parseDebugEvents } from "./transcript-debug.ts"
import {
  entryToDisplayTurn,
  formatTimestamp,
  hasToolResults,
  isNamedToolUseBlock,
  isVisibleTextBlock,
  prettifyUserMessageText,
  toContentBlocks,
} from "./transcript-format.ts"
import {
  type ContentBlock,
  extractText,
  getUnsupportedTranscriptFormatMessage,
  isHookFeedback as isHookFeedbackContent,
  isUnsupportedTranscriptFormat,
  parseTranscriptEntries,
  type Session,
  type TranscriptEntry,
} from "./transcript-utils.ts"
import { readJsonlTailTextFromFile, streamJsonlLinesFromFile } from "./utils/jsonl.ts"
import { stripAnsi } from "./utils/transcript.ts"

// ─── Turn cache ──────────────────────────────────────────────────────────────

interface CachedTurns {
  turns: Turn[]
  mtimeMs: number
}

const turnsCache = new LRUCache<string, CachedTurns>({ max: 50, ttl: 15_000 })
let _turnsCacheHits = 0
let _turnsCacheMisses = 0

export function getTurnsCacheStats(): { size: number; hits: number; misses: number } {
  return { size: turnsCache.size, hits: _turnsCacheHits, misses: _turnsCacheMisses }
}

export function invalidateTurnsCache(cwd: string): void {
  const projectKey = projectKeyFromCwd(cwd)
  for (const key of turnsCache.keys()) {
    if (key.includes(projectKey)) turnsCache.delete(key)
  }
}

// ─── Turn types ─────────────────────────────────────────────────────────────

export interface Turn {
  entry: TranscriptEntry
  role: "user" | "assistant"
}

type JsonlTranscriptFormat = Extract<
  Session["format"],
  "jsonl" | "cursor-agent-jsonl" | "codex-jsonl"
>

function getJsonlFormatHint(session: Session): JsonlTranscriptFormat | null {
  if (
    session.format === "jsonl" ||
    session.format === "cursor-agent-jsonl" ||
    session.format === "codex-jsonl"
  ) {
    return session.format
  }
  if (!session.format && session.path.endsWith(".jsonl")) return "jsonl"
  return null
}

// ─── Turn collection ────────────────────────────────────────────────────────

function cloneUserEntryWithPlainText(entry: TranscriptEntry, text: string): TranscriptEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "user",
      content: text,
    },
  }
}

function hasVisibleContent(entry: TranscriptEntry, text: string): boolean {
  if (entry.type === "assistant") {
    const blocks = toContentBlocks(entry.message?.content as string | ContentBlock[] | undefined)
    return blocks.some((b) => isVisibleTextBlock(b) || isNamedToolUseBlock(b))
  }
  return (
    hasToolResults(entry.message?.content as string | ContentBlock[] | undefined) || text.length > 0
  )
}

function isSuppressedUserMessage(text: string): boolean {
  const pretty = prettifyUserMessageText(text)
  return pretty !== undefined && pretty.text === null
}

function collectUserTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.message) continue
    const text = extractText(entry.message.content).trim()
    if (!text || isHookFeedbackContent(text)) continue
    if (isSuppressedUserMessage(text)) continue
    turns.push({ entry: cloneUserEntryWithPlainText(entry, text), role: "user" })
  }
  return turns
}

function collectTurns(entries: TranscriptEntry[], userOnly = false): Turn[] {
  if (userOnly) return collectUserTurns(entries)
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue
    if (!entry.message) continue
    const text = extractText(entry.message.content).trim()
    if (entry.type === "user" && isHookFeedbackContent(text)) continue
    if (entry.type === "user" && isSuppressedUserMessage(text)) continue
    if (!hasVisibleContent(entry, text)) continue
    turns.push({ entry, role: entry.type as "user" | "assistant" })
  }
  return turns
}

function collectTurnsFromJsonlText(
  text: string,
  formatHint: JsonlTranscriptFormat,
  userOnly: boolean
): Turn[] {
  return collectTurns(parseTranscriptEntries(text, formatHint), userOnly)
}

function turnMatchesTimeRange(turn: Turn, timeRange: TimeRange | undefined): boolean {
  if (!timeRange) return true
  const ts = turn.entry.timestamp
  if (!ts) return false
  const ms = new Date(ts).getTime()
  if (!Number.isFinite(ms)) return false
  if (timeRange.from !== undefined && ms < timeRange.from) return false
  if (timeRange.to !== undefined && ms > timeRange.to) return false
  return true
}

function appendFilteredTurns(
  output: Turn[],
  turns: Turn[],
  timeRange: TimeRange | undefined,
  limit: number | undefined
): boolean {
  for (const turn of turns) {
    if (!turnMatchesTimeRange(turn, timeRange)) continue
    output.push(turn)
    if (limit !== undefined && output.length >= limit) return true
  }
  return false
}

async function loadJsonlTurnsForward(
  file: Bun.BunFile,
  formatHint: JsonlTranscriptFormat,
  userOnly: boolean,
  timeRange?: TimeRange,
  limit?: number
): Promise<Turn[]> {
  if (limit !== undefined && limit <= 0) return []

  const turns: Turn[] = []
  for await (const line of streamJsonlLinesFromFile(file)) {
    if (!line.trim()) continue
    const parsedTurns = collectTurnsFromJsonlText(line, formatHint, userOnly)
    if (appendFilteredTurns(turns, parsedTurns, timeRange, limit)) return turns
  }

  return turns
}

function hasReachedTimeFloor(turns: Turn[], timeRange: TimeRange | undefined): boolean {
  if (timeRange?.from === undefined) return false
  return turns.some((turn) => {
    const ts = turn.entry.timestamp
    if (!ts) return false
    const ms = new Date(ts).getTime()
    return Number.isFinite(ms) && ms < timeRange.from!
  })
}

async function loadJsonlTurnsTail(
  file: Bun.BunFile,
  fileSize: number,
  formatHint: JsonlTranscriptFormat,
  userOnly: boolean,
  tailCount: number,
  timeRange?: TimeRange
): Promise<Turn[]> {
  if (tailCount <= 0) return []

  let selectedTurns: Turn[] = []
  await readJsonlTailTextFromFile(file, fileSize, {
    isEnough: (text, meta) => {
      if (!text.trim()) {
        selectedTurns = []
        return meta.reachedStart
      }
      const turns = text.trim() ? collectTurnsFromJsonlText(text, formatHint, userOnly) : []
      selectedTurns = timeRange ? filterTurnsByTime(turns, timeRange) : turns
      return selectedTurns.length >= tailCount || hasReachedTimeFloor(turns, timeRange)
    },
  })
  return selectedTurns.slice(-tailCount)
}

// ─── Turn loading ───────────────────────────────────────────────────────────

async function loadTurns(session: Session, userOnly = false): Promise<Turn[]> {
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  const file = Bun.file(session.path)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${session.path}`)
  }

  const stat = await file.stat()
  const mtimeMs = stat.mtimeMs ?? 0
  const cacheKey = `${session.path}:${userOnly ? "1" : "0"}`
  const cached = turnsCache.get(cacheKey)
  if (cached?.mtimeMs === mtimeMs) {
    _turnsCacheHits++
    return cached.turns
  }

  _turnsCacheMisses++
  const jsonlFormatHint = getJsonlFormatHint(session)
  if (jsonlFormatHint) {
    const turns = await loadJsonlTurnsForward(file, jsonlFormatHint, userOnly)
    turnsCache.set(cacheKey, { turns, mtimeMs })
    return turns
  }

  const text = await file.text()
  const turns = collectTurns(parseTranscriptEntries(text, session.format), userOnly)
  turnsCache.set(cacheKey, { turns, mtimeMs })
  return turns
}

async function loadWindowedJsonlTurns(
  session: Session,
  parsed: TranscriptArgs,
  timeRange: TimeRange | undefined
): Promise<Turn[] | null> {
  const formatHint = getJsonlFormatHint(session)
  if (!formatHint) return null
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  const file = Bun.file(session.path)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${session.path}`)
  }

  const stat = await file.stat()
  if (parsed.tailCount !== undefined) {
    return loadJsonlTurnsTail(
      file,
      stat.size,
      formatHint,
      parsed.userOnly,
      parsed.tailCount,
      timeRange
    )
  }
  if (parsed.headCount !== undefined) {
    return loadJsonlTurnsForward(file, formatHint, parsed.userOnly, timeRange, parsed.headCount)
  }
  return null
}

// ─── Utility ────────────────────────────────────────────────────────────────

function applyHeadTail<T>(
  values: T[],
  headCount: number | undefined,
  tailCount: number | undefined
): T[] {
  if (tailCount !== undefined) return values.slice(-tailCount)
  if (headCount !== undefined) return values.slice(0, headCount)
  return values
}

// ─── Time filtering ─────────────────────────────────────────────────────────

function filterTurnsByTime(turns: Turn[], range: TimeRange): Turn[] {
  return turns.filter((t) => {
    const ts = t.entry.timestamp
    if (!ts) return false
    const ms = new Date(ts).getTime()
    if (!Number.isFinite(ms)) return false
    if (range.from !== undefined && ms < range.from) return false
    if (range.to !== undefined && ms > range.to) return false
    return true
  })
}

function filterDebugEventsByTime(events: DebugEvent[], range: TimeRange): DebugEvent[] {
  return events.filter((e) => {
    if (range.from !== undefined && e.ts < range.from) return false
    if (range.to !== undefined && e.ts > range.to) return false
    return true
  })
}

// ─── Display turn conversion ────────────────────────────────────────────────

interface DisplayTurnsResult {
  displayTurns: DisplayTurn[]
  trailingDebug: Array<{ time: string; text: string }>
}

function debugEventToLine(evt: DebugEvent): { time: string; text: string } {
  return { time: formatTimestamp(evt.iso), text: stripAnsi(evt.text) }
}

function collectDebugLinesBefore(
  debug: DebugEvent[],
  startIdx: number,
  untilTs: number
): { lines: Array<{ time: string; text: string }>; nextIdx: number } {
  const lines: Array<{ time: string; text: string }> = []
  let idx = startIdx
  while (idx < debug.length && debug[idx] && debug[idx]!.ts <= untilTs) {
    lines.push(debugEventToLine(debug[idx]!))
    idx++
  }
  return { lines, nextIdx: idx }
}

export function turnsToDisplayTurns(turns: Turn[], debugEvents?: DebugEvent[]): DisplayTurnsResult {
  const displayTurns: DisplayTurn[] = []
  let debugIdx = 0
  const debug = debugEvents ?? []

  for (const { entry, role } of turns) {
    const turnTs = entry.timestamp ? new Date(entry.timestamp).getTime() : null
    if (turnTs !== null) {
      const { lines, nextIdx } = collectDebugLinesBefore(debug, debugIdx, turnTs)
      debugIdx = nextIdx
      const displayTurn = entryToDisplayTurn(entry, role)
      if (lines.length > 0) displayTurn.debugLines = lines
      displayTurns.push(displayTurn)
    } else {
      displayTurns.push(entryToDisplayTurn(entry, role))
    }
  }

  const trailingDebug: Array<{ time: string; text: string }> = []
  while (debugIdx < debug.length && debug[debugIdx]) {
    trailingDebug.push(debugEventToLine(debug[debugIdx]!))
    debugIdx++
  }

  return { displayTurns, trailingDebug }
}

// ─── Session content loading ────────────────────────────────────────────────

async function loadOptionalDebug(
  session: Session,
  parsed: TranscriptArgs,
  onDebugNotFound?: (sessionId: string) => void
): Promise<DebugEvent[] | undefined> {
  if (!parsed.includeDebug) return undefined
  const debugFile = await loadDebugLog(session.id)
  if (!debugFile) {
    onDebugNotFound?.(session.id)
    return undefined
  }
  return applyHeadTail(parseDebugEvents(debugFile.lines), parsed.headCount, parsed.tailCount)
}

export async function loadSessionContent(
  session: Session,
  parsed: TranscriptArgs,
  timeRange: TimeRange,
  hasTimeFilter: boolean,
  onDebugNotFound?: (sessionId: string) => void
): Promise<{ turns: Turn[]; debugEvents: DebugEvent[] | undefined }> {
  const windowedTurns = await loadWindowedJsonlTurns(
    session,
    parsed,
    hasTimeFilter ? timeRange : undefined
  )
  let turns: Turn[]
  if (windowedTurns) {
    turns = windowedTurns
  } else {
    let allTurns = await loadTurns(session, parsed.userOnly)
    if (hasTimeFilter) allTurns = filterTurnsByTime(allTurns, timeRange)
    turns = applyHeadTail(allTurns, parsed.headCount, parsed.tailCount)
  }
  let debugEvents = await loadOptionalDebug(session, parsed, onDebugNotFound)
  if (debugEvents && hasTimeFilter) debugEvents = filterDebugEventsByTime(debugEvents, timeRange)
  return { turns, debugEvents }
}
