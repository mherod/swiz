import { LRUCache } from "lru-cache"
import { projectKeyFromCwd } from "../../../project-key.ts"
import {
  collectSessionToolUsage,
  computeSummaryFromSessionLines,
  createEmptySummaryAccumulator,
  type SummaryAccumulator,
  type TranscriptSummary,
} from "../../../transcript-summary.ts"
import {
  JsonlAppendCursor,
  type JsonlAppendMetadata,
  readJsonlTailTextFromFile,
  splitJsonlLines,
  tryParseJsonLine,
} from "../../../utils/jsonl.ts"

export interface TranscriptIndex {
  summary: TranscriptSummary
  blockedToolUseIds: string[]
  mtimeMs: number
  size: number
  computedAt: number
}

export interface TranscriptIndexCacheDependencies {
  readMetadata?: (transcriptPath: string) => Promise<JsonlAppendMetadata | null>
  buildIndex?: (
    transcriptPath: string,
    fileSize: number,
    mtimeMs: number
  ) => Promise<TranscriptIndex | null>
}

interface IncrementalTranscriptIndex {
  index: TranscriptIndex
  accumulator: SummaryAccumulator
  cursor: JsonlAppendCursor
}

const MAX_TRANSCRIPT_INDEX_ENTRIES = 50
const MAX_CACHED_SESSION_LINE_CHARS = 16 * 1024 * 1024

function sessionLineCharCount(index: TranscriptIndex): number {
  return Math.max(
    1,
    index.summary.sessionLines.reduce((total, line) => total + line.length, 0)
  )
}

function compactTranscriptIndex(index: TranscriptIndex): TranscriptIndex {
  return {
    ...index,
    summary: { ...index.summary, sessionLines: [] },
  }
}

function extractToolResultText(block: { content?: string | unknown[] }): string {
  const blockContent = block.content
  if (typeof blockContent === "string") return blockContent
  if (!Array.isArray(blockContent)) return ""
  return (blockContent as Array<{ text?: string }>)
    .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
    .join("")
}

type ToolResultBlock = { type?: string; content?: string | unknown[]; tool_use_id?: string }

function isBlockedToolResult(block: ToolResultBlock): boolean {
  const text = extractToolResultText(block)
  return (
    block?.type === "tool_result" &&
    (text.includes("You must act on this now") || text.includes("Resolve this block"))
  )
}

function collectBlockedIdsFromEntry(line: string, blockedIds: string[]): void {
  const entry = tryParseJsonLine(line) as
    | {
        type?: string
        message?: { content?: string | unknown[] }
      }
    | undefined
  if (!entry || entry.type !== "user") return
  const content = entry?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content as ToolResultBlock[]) {
    if (isBlockedToolResult(block)) {
      blockedIds.push(String(block.tool_use_id ?? ""))
    }
  }
}

function extractBlockedToolUseIds(sessionLines: string[]): string[] {
  const blockedIds: string[] = []
  for (const line of sessionLines) {
    if (!line.trim()) continue
    try {
      collectBlockedIdsFromEntry(line, blockedIds)
    } catch {}
  }
  return blockedIds
}

/**
 * Return the index augmented with the cursor's pending unterminated line.
 *
 * The cold builder counts a final line without a trailing newline, but the
 * append cursor only surfaces newline-terminated records — so the two paths
 * disagreed at exactly the append boundary (#819). The tail is folded into a
 * fresh returned index only, never into the durable accumulator or stored
 * session lines: when the terminating newline lands, the same bytes arrive as
 * a complete line and are counted exactly once. A mid-write fragment fails the
 * JSON parse guard and leaves the index unchanged. Recomputing from lines
 * (bounded by the cache's session-line cap) happens only on unterminated
 * tails, which newline-terminated production appends do not produce.
 */
function withProvisionalTail(index: TranscriptIndex, tailText: string): TranscriptIndex {
  const tail = tailText.trim()
  if (!tail || !tryParseJsonLine(tail)) return index
  const sessionLines = [...index.summary.sessionLines, tail]
  const blockedToolUseIds = [...index.blockedToolUseIds]
  try {
    collectBlockedIdsFromEntry(tail, blockedToolUseIds)
  } catch {}
  return {
    summary: computeSummaryFromSessionLines(sessionLines),
    blockedToolUseIds,
    mtimeMs: index.mtimeMs,
    size: index.size,
    computedAt: Date.now(),
  }
}

function splitSessionLinesAfterLatestSystem(text: string): {
  sessionLines: string[]
  sawSystem: boolean
} {
  const lines = splitJsonlLines(text)
  let latestSystemIndex = -1
  for (let index = 0; index < lines.length; index++) {
    if (isSessionBoundary(lines[index]!)) latestSystemIndex = index
  }
  return {
    sessionLines: latestSystemIndex === -1 ? lines : lines.slice(latestSystemIndex + 1),
    sawSystem: latestSystemIndex !== -1,
  }
}

function isSessionBoundary(line: string): boolean {
  const entry = tryParseJsonLine(line) as { type?: string; payload?: { type?: string } } | undefined
  return (
    entry?.type === "system" ||
    entry?.type === "compacted" ||
    (entry?.type === "event_msg" && entry.payload?.type === "context_compacted")
  )
}

export class TranscriptIndexCache {
  private entries = new LRUCache<string, TranscriptIndex>({ max: MAX_TRANSCRIPT_INDEX_ENTRIES })
  private summaryEntries = new LRUCache<string, TranscriptIndex>({
    max: MAX_TRANSCRIPT_INDEX_ENTRIES,
    maxSize: MAX_CACHED_SESSION_LINE_CHARS,
    sizeCalculation: sessionLineCharCount,
  })
  private incrementalEntries = new LRUCache<string, IncrementalTranscriptIndex>({
    max: MAX_TRANSCRIPT_INDEX_ENTRIES,
    maxSize: MAX_CACHED_SESSION_LINE_CHARS,
    sizeCalculation: (entry) => sessionLineCharCount(entry.index),
  })
  private inFlight = new Map<string, Promise<TranscriptIndex | null>>()
  private _hits = 0
  private _misses = 0
  private _appendedBytes = 0
  private _coldRebuilds = 0
  private _resets = 0

  constructor(private readonly dependencies: TranscriptIndexCacheDependencies = {}) {}

  async get(transcriptPath: string): Promise<TranscriptIndex | null> {
    try {
      const metadata = await this.readMetadata(transcriptPath)
      if (!metadata) return null
      const cached = this.entries.get(transcriptPath)
      // Mtime alone misses appends that land within the filesystem's mtime
      // granularity, so an unchanged file is (mtimeMs, size)-identical (#819).
      if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
        cached.computedAt = Date.now()
        this._hits++
        return cached
      }

      const built = await this.getOrBuild(transcriptPath, metadata)
      return built ? (this.entries.get(transcriptPath) ?? compactTranscriptIndex(built)) : null
    } catch {
      return null
    }
  }

  async getSummary(transcriptPath: string): Promise<TranscriptSummary | null> {
    try {
      const metadata = await this.readMetadata(transcriptPath)
      if (!metadata) return null
      const cached = this.summaryEntries.get(transcriptPath)
      if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
        cached.computedAt = Date.now()
        this._hits++
        return cached.summary
      }

      const built = await this.getOrBuild(transcriptPath, metadata)
      return built?.summary ?? null
    } catch {
      return null
    }
  }

  private async readMetadata(transcriptPath: string): Promise<JsonlAppendMetadata | null> {
    return this.dependencies.readMetadata
      ? await this.dependencies.readMetadata(transcriptPath)
      : await Bun.file(transcriptPath).stat()
  }

  private async getOrBuild(
    transcriptPath: string,
    metadata: JsonlAppendMetadata
  ): Promise<TranscriptIndex | null> {
    const inFlightKey = `${transcriptPath}\0${metadata.size}\0${metadata.mtimeMs}`
    const existing = this.inFlight.get(inFlightKey)
    if (existing) return await existing

    this._misses++
    let computation: Promise<TranscriptIndex | null>
    const build = this.dependencies.buildIndex
      ? this.dependencies.buildIndex(transcriptPath, metadata.size, metadata.mtimeMs)
      : this.buildOrAppendIndex(transcriptPath, metadata)
    computation = build
      .then((index) => {
        if (index && this.inFlight.get(inFlightKey) === computation) {
          this.entries.set(transcriptPath, compactTranscriptIndex(index))
          if (this.dependencies.buildIndex) this.summaryEntries.set(transcriptPath, index)
        }
        return index
      })
      .finally(() => {
        if (this.inFlight.get(inFlightKey) === computation) {
          this.inFlight.delete(inFlightKey)
        }
      })
    this.inFlight.set(inFlightKey, computation)
    return await computation
  }

  private async buildOrAppendIndex(
    transcriptPath: string,
    metadata: JsonlAppendMetadata
  ): Promise<TranscriptIndex | null> {
    const existing = this.incrementalEntries.get(transcriptPath)
    if (existing) {
      const update = await existing.cursor.read(transcriptPath, metadata)
      if (update.kind === "hit") {
        existing.index.computedAt = Date.now()
        existing.index.mtimeMs = metadata.mtimeMs
        existing.index.size = metadata.size
        this._hits++
        return withProvisionalTail(existing.index, existing.cursor.tailText)
      }
      if (update.kind === "append") {
        this._appendedBytes += update.bytesRead
        let accumulator = existing.accumulator
        let sessionLines = existing.index.summary.sessionLines
        let blockedIds = existing.index.blockedToolUseIds
        for (const line of update.lines) {
          if (isSessionBoundary(line)) {
            accumulator = createEmptySummaryAccumulator()
            sessionLines = []
            blockedIds = []
            this._resets++
            continue
          }
          sessionLines.push(line)
          collectSessionToolUsage([line], accumulator)
          collectBlockedIdsFromEntry(line, blockedIds)
        }
        const index = this.createIndex(sessionLines, accumulator, blockedIds, metadata)
        this.incrementalEntries.set(transcriptPath, {
          index,
          accumulator,
          cursor: existing.cursor,
        })
        return withProvisionalTail(index, existing.cursor.tailText)
      }
    }

    this._coldRebuilds++
    const built = await this.buildIndex(Bun.file(transcriptPath), metadata.size, metadata.mtimeMs)
    if (!built) return null
    const accumulator = collectSessionToolUsage(built.summary.sessionLines)
    const cursor = new JsonlAppendCursor()
    cursor.reset(metadata)
    this.incrementalEntries.set(transcriptPath, { index: built, accumulator, cursor })
    return built
  }

  private async buildIndex(
    transcriptFile: Bun.BunFile,
    fileSize: number,
    mtimeMs: number
  ): Promise<TranscriptIndex | null> {
    try {
      let sessionLines: string[] = []
      await readJsonlTailTextFromFile(transcriptFile, fileSize, {
        isEnough: (text, meta) => {
          const result = splitSessionLinesAfterLatestSystem(text)
          sessionLines = result.sessionLines
          return result.sawSystem || meta.reachedStart
        },
      })
      const summary = computeSummaryFromSessionLines(sessionLines)
      const blockedIds = extractBlockedToolUseIds(sessionLines)

      const index: TranscriptIndex = {
        summary,
        blockedToolUseIds: blockedIds,
        mtimeMs,
        size: fileSize,
        computedAt: Date.now(),
      }
      return index
    } catch {
      return null
    }
  }

  private createIndex(
    sessionLines: string[],
    accumulator: SummaryAccumulator,
    blockedToolUseIds: string[],
    metadata: JsonlAppendMetadata
  ): TranscriptIndex {
    return {
      summary: computeSummaryFromSessionLines(sessionLines, accumulator),
      blockedToolUseIds,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      computedAt: Date.now(),
    }
  }

  /** Invalidate only entries whose transcript path contains the project key for `cwd`. */
  invalidateProject(cwd: string): void {
    const projectKey = projectKeyFromCwd(cwd)
    for (const key of this.entries.keys()) {
      if (key.includes(projectKey)) this.entries.delete(key)
    }
    for (const key of this.summaryEntries.keys()) {
      if (key.includes(projectKey)) this.summaryEntries.delete(key)
    }
    for (const key of this.incrementalEntries.keys()) {
      if (key.includes(projectKey)) this.incrementalEntries.delete(key)
    }
    for (const key of this.inFlight.keys()) {
      if (key.includes(projectKey)) this.inFlight.delete(key)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
    this.summaryEntries.clear()
    this.incrementalEntries.clear()
    this.inFlight.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get summarySize(): number {
    return this.summaryEntries.size + this.incrementalEntries.size
  }

  get hits(): number {
    return this._hits
  }

  get misses(): number {
    return this._misses
  }

  get appendedBytes(): number {
    return this._appendedBytes
  }

  get coldRebuilds(): number {
    return this._coldRebuilds
  }

  get resets(): number {
    return this._resets
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [path, entry] of this.entries) {
      if (entry.computedAt < cutoffMs) this.entries.delete(path)
    }
    for (const [path, entry] of this.summaryEntries) {
      if (entry.computedAt < cutoffMs) this.summaryEntries.delete(path)
    }
    for (const [path, entry] of this.incrementalEntries) {
      if (entry.index.computedAt < cutoffMs) this.incrementalEntries.delete(path)
    }
  }
}
