import { LRUCache } from "lru-cache"
import { projectKeyFromCwd } from "../../../project-key.ts"
import { parseTranscriptSummary, type TranscriptSummary } from "../../../transcript-summary.ts"

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
  const entry = JSON.parse(line) as {
    type?: string
    message?: { content?: string | unknown[] }
  }
  if (entry?.type !== "user") return
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
  private entries = new LRUCache<string, TranscriptIndex>({ max: 200 })
  private _hits = 0
  private _misses = 0

  async get(transcriptPath: string): Promise<TranscriptIndex | null> {
    try {
      const file = Bun.file(transcriptPath)
      const stat = await file.stat()
      const mtimeMs = stat.mtimeMs ?? 0
      const cached = this.entries.get(transcriptPath)
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.computedAt = Date.now()
        this._hits++
        return cached
      }
      this._misses++
      const text = await file.text()
      const summary = parseTranscriptSummary(text)
      const blockedIds = extractBlockedToolUseIds(summary.sessionLines)
      const index: TranscriptIndex = {
        summary,
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
