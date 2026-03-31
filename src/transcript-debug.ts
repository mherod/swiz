import { join } from "node:path"
import { orderBy } from "lodash-es"
import { getHomeDirOrNull } from "./home.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DebugLog {
  path: string
  lines: string[]
}

export interface DebugEvent {
  iso: string
  ts: number
  text: string
}

// ─── Debug log loading ──────────────────────────────────────────────────────

export async function loadDebugLog(sessionId: string): Promise<DebugLog | null> {
  const home = getHomeDirOrNull()
  if (!home) return null

  const path = join(home, ".claude", "debug", `${sessionId}.txt`)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const text = await file.text()
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  return { path, lines }
}

// ─── Debug event parsing ────────────────────────────────────────────────────

const DEBUG_TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+/

type TaggedDebugEvent = DebugEvent & { _idx: number; _malformed: boolean; _seq: number }

function classifyDebugLine(
  line: string,
  idx: number,
  validEvents: TaggedDebugEvent[],
  malformedEvents: TaggedDebugEvent[],
  allEvents: TaggedDebugEvent[]
): void {
  const m = DEBUG_TS_RE.exec(line)
  if (!m) {
    const prev = allEvents[allEvents.length - 1]
    if (prev) {
      prev.text += `\n${line}`
    } else {
      const tagged: TaggedDebugEvent = {
        iso: "",
        ts: 0,
        text: line,
        _idx: idx,
        _malformed: true,
        _seq: malformedEvents.length,
      }
      malformedEvents.push(tagged)
      allEvents.push(tagged)
    }
    return
  }
  const iso = m[1]
  if (iso === undefined) return
  const parsed = new Date(iso).getTime()
  const isMalformed = Number.isNaN(parsed)
  const tagged: TaggedDebugEvent = {
    iso,
    ts: isMalformed ? 0 : parsed,
    text: line.slice(m[0].length),
    _idx: idx,
    _malformed: isMalformed,
    _seq: isMalformed ? malformedEvents.length : 0,
  }
  ;(isMalformed ? malformedEvents : validEvents).push(tagged)
  allEvents.push(tagged)
}

function normalizeMalformedEvents(events: TaggedDebugEvent[]): void {
  for (const ev of events) {
    if (typeof ev.iso !== "string") ev.iso = ""
    if (typeof ev._idx !== "number" || !Number.isFinite(ev._idx)) ev._idx = 0
    if (typeof ev._seq !== "number" || !Number.isFinite(ev._seq)) ev._seq = 0
  }
}

function mergeValidAndMalformed(
  sortedValid: TaggedDebugEvent[],
  sortedMalformed: TaggedDebugEvent[]
): TaggedDebugEvent[] {
  const result: TaggedDebugEvent[] = []
  let vi = 0
  for (const malformed of sortedMalformed) {
    while (vi < sortedValid.length && (sortedValid[vi]?._idx ?? Infinity) < malformed._idx) {
      result.push(sortedValid[vi]!)
      vi++
    }
    result.push(malformed)
  }
  while (vi < sortedValid.length) {
    result.push(sortedValid[vi]!)
    vi++
  }
  return result
}

export function parseDebugEvents(lines: string[]): DebugEvent[] {
  const validEvents: TaggedDebugEvent[] = []
  const malformedEvents: TaggedDebugEvent[] = []
  const allEvents: TaggedDebugEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    classifyDebugLine(line, i, validEvents, malformedEvents, allEvents)
  }

  const sortedValid = orderBy(validEvents, [(ev) => ev.ts, (ev) => ev._idx], ["asc", "asc"])
  normalizeMalformedEvents(malformedEvents)
  const sortedMalformed = orderBy(
    malformedEvents,
    [(ev) => ev._idx ?? 0, (ev) => String(ev.iso ?? ""), (ev) => ev._seq ?? 0],
    ["asc", "asc", "asc"]
  )

  return mergeValidAndMalformed(sortedValid, sortedMalformed).map(({ iso, ts, text }) => ({
    iso,
    ts,
    text,
  }))
}
