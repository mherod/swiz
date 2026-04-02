import { LRUCache } from "lru-cache"
import { projectKeyFromCwd } from "../../../project-key.ts"
import {
  computeSummaryFromSessionLines,
  type TranscriptSummary,
} from "../../../transcript-summary.ts"
import { tryParseJsonLine } from "../../../utils/jsonl.ts"

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

export class TranscriptIndexCache {
  private entries = new LRUCache<string, TranscriptIndex>({ max: 50 })
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
      this._misses++

      // Use a two-pass approach to avoid loading the entire file into memory.
      // 1. Stream the file to find the byte offset of the last "system" entry.
      // 2. Read only from that offset to EOF.
      if (!(await transcriptFile.exists())) return null

      let lastSystemByteOffset = 0
      let currentByteOffset = 0

      const stream = transcriptFile.stream()
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let remaining = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = (remaining + chunk).split("\n")
          const lastLineInChunk = lines.pop() ?? ""

          for (const line of lines) {
            const lineByteLength = Buffer.byteLength(`${line}\n`)
            const parsed = tryParseJsonLine(line) as { type?: string } | undefined
            if (parsed?.type === "system") {
              lastSystemByteOffset = currentByteOffset + lineByteLength
            }
            currentByteOffset += lineByteLength
          }
          remaining = lastLineInChunk
        }

        const final = remaining + decoder.decode()
        const parsed = tryParseJsonLine(final) as { type?: string } | undefined
        if (parsed?.type === "system") {
          lastSystemByteOffset = currentByteOffset + Buffer.byteLength(final)
        }
      } finally {
        reader.releaseLock()
      }

      // 2. Read from lastSystemByteOffset to EOF.
      const sessionFile = transcriptFile.slice(lastSystemByteOffset)
      const sessionText = await sessionFile.text()
      const sessionLines = sessionText.split("\n").filter((l) => l.trim())
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
      this.entries.set(transcriptPath, index)
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
  }

  invalidateAll(): void {
    this.entries.clear()
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
