import { classifyCodexLine, parseJsonlRecord } from "../../transcript-analysis-parse-part1.ts"
import type { Session, TranscriptEntry } from "../../transcript-schemas.ts"
import {
  JsonlAppendCursor,
  type JsonlAppendMetadata,
  readJsonlTailTextFromFile,
  tryParseJsonLine,
} from "../../utils/jsonl.ts"
import { MAX_SESSION_PREVIEW_BYTES } from "./session-preview.ts"
import {
  MAX_TRANSCRIPT_ENTRIES,
  messageRetainedChars,
  type PreparedSessionEntry,
  prepareSessionEntry,
  readTokenSample,
  type SessionTokenSample,
  type SessionTokenStats,
  summarizeTokenSamples,
} from "./session-records.ts"

type IncrementalFormat = "jsonl" | "cursor-agent-jsonl" | "codex-jsonl"

export function supportsHistoricalAppend(format: Session["format"]): format is IncrementalFormat {
  return format === "jsonl" || format === "cursor-agent-jsonl" || format === "codex-jsonl"
}

function parseRecord(value: unknown, format: IncrementalFormat): TranscriptEntry[] {
  if (format === "codex-jsonl") {
    const entries: TranscriptEntry[] = []
    /** Session IDs are not part of historical message/tool/token views. */
    classifyCodexLine(value, undefined, entries)
    return entries
  }
  const entry = parseJsonlRecord(value)
  return entry ? [entry] : []
}

/** Compact, disposable derived state within the same byte window as a cold preview. */
export class HistoricalJsonlState {
  readonly cursor = new JsonlAppendCursor()
  private entries = new Map<number, PreparedSessionEntry>()
  private samples = new Map<number, SessionTokenSample>()
  private latestSample?: SessionTokenSample
  private latestTimedSample?: SessionTokenSample
  private cutoff = 0
  private continuable = true

  constructor(readonly format: IncrementalFormat) {}

  private consume = (line: string, position: number): void => {
    if (position < this.cutoff) return
    const value = tryParseJsonLine(line)
    if (value === undefined) return
    for (const entry of parseRecord(value, this.format)) {
      this.entries.set(position, prepareSessionEntry(entry, position))
    }
    if (this.entries.size > MAX_TRANSCRIPT_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!)
    }
    const sample = readTokenSample(value, position)
    if (sample) {
      this.samples.set(position, sample)
      this.latestSample = sample
      if (Number.isFinite(sample.at)) this.latestTimedSample = sample
    }
  }

  async read(file: Bun.BunFile, metadata: JsonlAppendMetadata): Promise<"hit" | "append" | "cold"> {
    this.cutoff = Math.max(0, metadata.size - MAX_SESSION_PREVIEW_BYTES)
    this.prune()
    if (!this.continuable) this.cursor.clear()
    const update = await this.cursor.read(file, metadata, this.consume)
    if (update.kind === "cold") {
      this.entries.clear()
      this.samples.clear()
      this.latestSample = undefined
      this.latestTimedSample = undefined
      const cold = await readJsonlTailTextFromFile(file, metadata.size, {
        initialBytes: MAX_SESSION_PREVIEW_BYTES,
        maxBytes: MAX_SESSION_PREVIEW_BYTES,
        includeUnterminated: false,
        onLine: this.consume,
      })
      this.cursor.seed(metadata, cold.pendingTail)
      /** A clipped record with no visible newline cannot seed a continuation safely. */
      this.continuable = cold.reachedStart || cold.startOffset < metadata.size
    }
    return update.kind
  }

  private prune(): void {
    for (const window of [this.entries, this.samples]) {
      for (const position of window.keys()) {
        if (position >= this.cutoff) break
        window.delete(position)
      }
    }
    if (this.latestSample && this.latestSample.position < this.cutoff) this.latestSample = undefined
    if (this.latestTimedSample && this.latestTimedSample.position < this.cutoff)
      this.latestTimedSample = undefined
  }

  view(size: number): {
    entries: PreparedSessionEntry[]
    tokenStats: SessionTokenStats | undefined
  } {
    const position = size - this.cursor.tailByteLength
    const value = position >= this.cutoff ? tryParseJsonLine(this.cursor.tailText) : undefined
    const provisional =
      value === undefined
        ? []
        : parseRecord(value, this.format).map((entry) => prepareSessionEntry(entry, position))
    const sample = readTokenSample(value, position)
    const first = this.samples.values().next().value ?? sample
    const latest = sample ?? this.latestSample
    const timed = sample && Number.isFinite(sample.at) ? sample : this.latestTimedSample
    const entries = [...this.entries.values(), ...provisional].slice(-MAX_TRANSCRIPT_ENTRIES)
    return {
      entries,
      tokenStats: summarizeTokenSamples(first, latest, timed?.at ?? 0),
    }
  }

  get retainedBytes(): number {
    let bytes = this.cursor.tailByteLength + this.samples.size * 160
    for (const entry of this.entries.values()) {
      bytes += 128 + (entry.message ? messageRetainedChars(entry.message) * 2 : 0)
    }
    return bytes
  }
}
