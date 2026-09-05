import { readLastTranscriptUserMessage } from "../../../utils/transcript-user-message.ts"
import { CappedMap } from "./capped-map.ts"

/** Where the daemon learned a session's last user-message time. */
export type LastUserMessageSource = "hook" | "transcript"

export interface LastUserMessage {
  /** Epoch milliseconds of the most recent user message in the session. */
  at: number
  /** How the time was observed — `hook` is authoritative, `transcript` is a fallback seed. */
  source: LastUserMessageSource
}

/**
 * Read a transcript file's tail and return the latest user-message time (epoch ms).
 * Scans backwards in fixed chunks, including for Codex messages. Returns null
 * when the file is missing/unreadable or has no readable user message.
 */
export async function findLastUserMessageMsFromTranscript(
  transcriptPath: string
): Promise<number | null> {
  return (await readLastTranscriptUserMessage(transcriptPath, true))?.at ?? null
}

/**
 * Hot in-memory store of the last user-message time per session.
 *
 * Fed by two sources:
 *  - the `userPromptSubmit` hook dispatch (authoritative, monotonic), via {@link recordFromHook}
 *  - the session transcript (fallback seed when the daemon never saw the hook), via {@link get}
 *
 * Lookups are synchronous when the value is already hot ({@link peek}); {@link get}
 * adds a one-time transcript scan, coalesced per session so concurrent callers share
 * a single read.
 */
export class LastUserMessageCache {
  private entries = new CappedMap<string, LastUserMessage>(200)
  private inFlight = new Map<string, Promise<LastUserMessage | null>>()

  /**
   * Record a user message observed via the `userPromptSubmit` hook. Authoritative:
   * never moves the recorded time backwards, so a stale transcript seed cannot win.
   */
  recordFromHook(sessionId: string, atMs: number): void {
    if (!sessionId || !Number.isFinite(atMs)) return
    const prev = this.entries.get(sessionId)
    if (prev && prev.at >= atMs && prev.source === "hook") return
    this.entries.set(sessionId, { at: atMs, source: "hook" })
  }

  /** Synchronous fast lookup. Returns the hot entry, or null when nothing is cached. */
  peek(sessionId: string): LastUserMessage | null {
    return this.entries.get(sessionId) ?? null
  }

  /**
   * Fast lookup with transcript fallback. Returns the hot entry when present; otherwise
   * scans the transcript once (when a path is given) and seeds the cache from it.
   */
  async get(sessionId: string, transcriptPath?: string | null): Promise<LastUserMessage | null> {
    const cached = this.entries.get(sessionId)
    if (cached) return cached
    if (!transcriptPath) return null
    const inflight = this.inFlight.get(sessionId)
    if (inflight) return inflight
    const computation = this.seedFromTranscript(sessionId, transcriptPath).finally(() => {
      this.inFlight.delete(sessionId)
    })
    this.inFlight.set(sessionId, computation)
    return computation
  }

  private async seedFromTranscript(
    sessionId: string,
    transcriptPath: string
  ): Promise<LastUserMessage | null> {
    // A hook may have recorded while this scan was queued — prefer it.
    const existing = this.entries.get(sessionId)
    if (existing) return existing
    const ms = await findLastUserMessageMsFromTranscript(transcriptPath)
    if (ms === null) return null
    // Re-check after the await: don't clobber a newer hook-sourced entry.
    const latest = this.entries.get(sessionId)
    if (latest && latest.at >= ms) return latest
    const entry: LastUserMessage = { at: ms, source: "transcript" }
    this.entries.set(sessionId, entry)
    return entry
  }

  /** Drop sessions whose last user message is older than `cutoffMs`. */
  pruneOlderThan(cutoffMs: number): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.at < cutoffMs) this.entries.delete(sessionId)
    }
  }

  invalidate(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  invalidateAll(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
