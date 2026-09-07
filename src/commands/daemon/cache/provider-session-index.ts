import { resolve } from "node:path"
import { LRUCache } from "lru-cache"
import { getHomeDir } from "../../../home.ts"
import { findAllProviderSessions, type Session } from "../../../transcript-utils.ts"

/**
 * Bounded index of provider discovery results.
 *
 * `findAllProviderSessions` fans out to six providers and re-sorts on every call. The dashboard
 * polls session lists and session details every two seconds, and both `listProjectSessions` and
 * `resolveSession` called it independently per request, so an unchanged project re-walked every
 * provider root many times a minute. Against a real store (883 Codex transcripts across 36
 * directories) that is on the order of 1.5M file stats per hour for one dashboard.
 *
 * This caches metadata descriptors only — never transcript bodies — and preserves the exact
 * ordering `findAllProviderSessions` produces, so callers see an unchanged contract.
 */

/** Entries older than this are revalidated even without a watcher signal. */
export const PROVIDER_INDEX_MAX_STALENESS_MS = 5_000

/** Distinct project/home keys retained. */
export const PROVIDER_INDEX_MAX_KEYS = 100

/** Total descriptors retained across all keys. */
export const PROVIDER_INDEX_MAX_DESCRIPTORS = 10_000

// Matches SNAPSHOT_KEY_SEPARATOR in daemon.ts. Written as an escape, never as a literal byte:
// a raw NUL in source makes the file binary to Git and silently breaks grep and edits.
const KEY_SEPARATOR = "\x00"

interface IndexEntry {
  /** Full deterministic newest-first result. Caller limits are applied to a copy of this. */
  sessions: Session[]
  filledAt: number
  /** Set while a fill is running so concurrent callers coalesce onto one provider walk. */
  inFlight: Promise<Session[]> | null
}

export interface ProviderSessionIndexMetrics {
  /** Requests served from a live entry without a provider walk. */
  hits: number
  /** Requests that triggered a provider walk. */
  misses: number
  /** Requests that joined an in-flight walk instead of starting their own. */
  coalesced: number
  /** Entries dropped by an explicit watcher invalidation. */
  invalidations: number
  /** Entries refreshed because they passed the staleness deadline. */
  staleRefreshes: number
  keys: number
  descriptors: number
}

export interface ProviderSessionIndexOptions {
  maxKeys?: number
  maxDescriptors?: number
  maxStalenessMs?: number
  /** Injected for deterministic tests. */
  now?: () => number
  /** Injected for deterministic tests; defaults to the real provider walk. */
  discover?: (projectDir: string, home?: string) => Promise<Session[]>
}

/**
 * Canonical cache key. Caller spelling (`.`, trailing slash, `..` segments) must not split one
 * project into several entries, or the index would miss on every alternate spelling.
 */
export function providerIndexKey(projectDir: string, home?: string): string {
  return `${resolve(projectDir)}${KEY_SEPARATOR}${home ?? getHomeDir()}`
}

export class ProviderSessionIndex {
  private readonly maxStalenessMs: number
  private readonly now: () => number
  private readonly discover: (projectDir: string, home?: string) => Promise<Session[]>
  private readonly entries: LRUCache<string, IndexEntry>
  private hits = 0
  private misses = 0
  private coalesced = 0
  private invalidations = 0
  private staleRefreshes = 0

  constructor(options: ProviderSessionIndexOptions = {}) {
    this.maxStalenessMs = options.maxStalenessMs ?? PROVIDER_INDEX_MAX_STALENESS_MS
    this.now = options.now ?? Date.now
    this.discover = options.discover ?? ((dir, home) => findAllProviderSessions(dir, home))
    this.entries = new LRUCache<string, IndexEntry>({
      max: options.maxKeys ?? PROVIDER_INDEX_MAX_KEYS,
      maxSize: options.maxDescriptors ?? PROVIDER_INDEX_MAX_DESCRIPTORS,
      // Size in descriptors, not bytes: the documented bound is a descriptor count. An empty
      // result must still cost 1 or lru-cache rejects a zero-size entry.
      sizeCalculation: (entry) => Math.max(1, entry.sessions.length),
    })
  }

  /**
   * Discovery result for a project, newest first.
   *
   * `limit` is applied after reading the indexed full result, so callers asking for different
   * limits share one walk and still see the same prefix semantics as direct discovery.
   */
  async get(projectDir: string, home?: string, limit?: number): Promise<Session[]> {
    const key = providerIndexKey(projectDir, home)
    const entry = this.entries.get(key)

    if (entry) {
      if (entry.inFlight) {
        this.coalesced++
        return applyLimit(await entry.inFlight, limit)
      }
      if (this.now() - entry.filledAt < this.maxStalenessMs) {
        this.hits++
        return applyLimit(entry.sessions, limit)
      }
      this.staleRefreshes++
    }

    this.misses++
    return applyLimit(await this.fill(key, projectDir, home), limit)
  }

  /** Drop this project's entries in response to a watcher signal. */
  invalidate(projectDir: string, home?: string): void {
    const prefix = `${resolve(projectDir)}${KEY_SEPARATOR}`
    for (const key of [...this.entries.keys()]) {
      if (key === providerIndexKey(projectDir, home) || key.startsWith(prefix)) {
        this.entries.delete(key)
        this.invalidations++
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }

  /** Aggregate counters only — never paths, cwd values, session ids, or transcript data. */
  getMetrics(): ProviderSessionIndexMetrics {
    let descriptors = 0
    for (const entry of this.entries.values()) descriptors += entry.sessions.length
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      invalidations: this.invalidations,
      staleRefreshes: this.staleRefreshes,
      keys: this.entries.size,
      descriptors,
    }
  }

  private fill(key: string, projectDir: string, home?: string): Promise<Session[]> {
    const pending = this.discover(projectDir, home)
    // Publish the in-flight promise before awaiting so a concurrent caller joins this walk.
    const placeholder: IndexEntry = {
      sessions: [],
      filledAt: this.now(),
      inFlight: pending,
    }
    this.entries.set(key, placeholder)

    return pending
      .then((sessions) => {
        // A watcher invalidation during the walk must win: only refresh the entry that is still
        // ours, or a stale result would be reinstated over a newer signal.
        if (this.entries.get(key) === placeholder) {
          this.entries.set(key, { sessions, filledAt: this.now(), inFlight: null })
        }
        return sessions
      })
      .catch((err) => {
        if (this.entries.get(key) === placeholder) this.entries.delete(key)
        throw err
      })
  }
}

function applyLimit(sessions: Session[], limit?: number): Session[] {
  return limit === undefined ? sessions : sessions.slice(0, limit)
}
