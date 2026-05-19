import { LRUCache } from "lru-cache"
import { projectKeyFromCwd } from "../../../project-key.ts"
import {
  computeSummaryFromSessionLines,
  type TranscriptSummary,
} from "../../../transcript-summary.ts"
import {
  readJsonlTailTextFromFile,
  splitJsonlLines,
  tryParseJsonLine,
} from "../../../utils/jsonl.ts"

export interface TranscriptIndex {
  summary: TranscriptSummary
  blockedToolUseIds: string[]
  mtimeMs: number
  computedAt: number
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

function splitSessionLinesAfterLatestSystem(text: string): {
  sessionLines: string[]
  sawSystem: boolean
} {
  const lines = splitJsonlLines(text)
  let latestSystemIndex = -1
  for (let index = 0; index < lines.length; index++) {
    const parsed = tryParseJsonLine(lines[index]!) as { type?: string } | undefined
    if (parsed?.type === "system") latestSystemIndex = index
  }
  return {
    sessionLines: latestSystemIndex === -1 ? lines : lines.slice(latestSystemIndex + 1),
    sawSystem: latestSystemIndex !== -1,
  }
}

export class TranscriptIndexCache {
  private entries = new LRUCache<string, TranscriptIndex>({ max: 50 })
  private inFlight = new Map<string, Promise<TranscriptIndex | null>>()
  private _hits = 0
  private _misses = 0

  async get(transcriptPath: string): Promise<TranscriptIndex | null> {
    try {
      const transcriptFile = Bun.file(transcriptPath)
      const stat = await transcriptFile.stat()
      const mtimeMs = stat.mtimeMs ?? 0
      const cached = this.entries.get(transcriptPath)
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.computedAt = Date.now()
        this._hits++
        return cached
      }

      if (!(await transcriptFile.exists())) return null

      const inFlightKey = `${transcriptPath}\0${mtimeMs}`
      const existing = this.inFlight.get(inFlightKey)
      if (existing) return await existing

      this._misses++
      let computation: Promise<TranscriptIndex | null>
      computation = this.buildIndex(transcriptFile, stat.size, mtimeMs)
        .then((index) => {
          if (index && this.inFlight.get(inFlightKey) === computation) {
            this.entries.set(transcriptPath, index)
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
    } catch {
      return null
    }
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

      // Strip sessionLines before caching — raw JSONL lines can be GB-scale for large sessions
      // (tool_result blocks embed full file content). All derived data (toolNames, bashCommands, etc.)
      // is already extracted. The daemon dispatch path sets disableTranscriptSummaryFallback=true
      // so sessionLines is never consumed from the cached index.
      const index: TranscriptIndex = {
        summary: { ...summary, sessionLines: [] },
        blockedToolUseIds: blockedIds,
        mtimeMs,
        computedAt: Date.now(),
      }
      return index
    } catch {
      return null
    }
  }

  /** Invalidate only entries whose transcript path contains the project key for `cwd`. */
  invalidateProject(cwd: string): void {
    const projectKey = projectKeyFromCwd(cwd)
    for (const key of this.entries.keys()) {
      if (key.includes(projectKey)) this.entries.delete(key)
    }
    for (const key of this.inFlight.keys()) {
      if (key.includes(projectKey)) this.inFlight.delete(key)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get hits(): number {
    return this._hits
  }

  get misses(): number {
    return this._misses
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [path, entry] of this.entries) {
      if (entry.computedAt < cutoffMs) this.entries.delete(path)
    }
  }
}
