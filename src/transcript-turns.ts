import type { DisplayTurn } from "../scripts/transcript/monitor-state.ts"
import type { TimeRange, TranscriptArgs } from "./transcript-args.ts"
import { type DebugEvent, loadDebugLog, parseDebugEvents } from "./transcript-debug.ts"
import {
  entryToDisplayTurn,
  formatTimestamp,
  hasToolResults,
  isNamedToolUseBlock,
  isVisibleTextBlock,
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
import { stripAnsi } from "./utils/transcript.ts"

// ─── Turn types ─────────────────────────────────────────────────────────────

export interface Turn {
  entry: TranscriptEntry
  role: "user" | "assistant"
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

function collectUserTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.message) continue
    const text = extractText(entry.message.content).trim()
    if (!text || isHookFeedbackContent(text)) continue
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
    if (!hasVisibleContent(entry, text)) continue
    turns.push({ entry, role: entry.type as "user" | "assistant" })
  }
  return turns
}

// ─── Turn loading ───────────────────────────────────────────────────────────

export async function loadTurns(session: Session, userOnly = false): Promise<Turn[]> {
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  const file = Bun.file(session.path)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${session.path}`)
  }
  const text = await file.text()
  return collectTurns(parseTranscriptEntries(text, session.format), userOnly)
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function applyHeadTail<T>(
  values: T[],
  headCount: number | undefined,
  tailCount: number | undefined
): T[] {
  if (tailCount !== undefined) return values.slice(-tailCount)
  if (headCount !== undefined) return values.slice(0, headCount)
  return values
}

// ─── Time filtering ─────────────────────────────────────────────────────────

export function filterTurnsByTime(turns: Turn[], range: TimeRange): Turn[] {
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

export function filterDebugEventsByTime(events: DebugEvent[], range: TimeRange): DebugEvent[] {
  return events.filter((e) => {
    if (range.from !== undefined && e.ts < range.from) return false
    if (range.to !== undefined && e.ts > range.to) return false
    return true
  })
}

// ─── Display turn conversion ────────────────────────────────────────────────

export interface DisplayTurnsResult {
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

export async function loadOptionalDebug(
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
  let allTurns = await loadTurns(session, parsed.userOnly)
  if (hasTimeFilter) allTurns = filterTurnsByTime(allTurns, timeRange)
  const turns = applyHeadTail(allTurns, parsed.headCount, parsed.tailCount)
  let debugEvents = await loadOptionalDebug(session, parsed, onDebugNotFound)
  if (debugEvents && hasTimeFilter) debugEvents = filterDebugEventsByTime(debugEvents, timeRange)
  return { turns, debugEvents }
}
