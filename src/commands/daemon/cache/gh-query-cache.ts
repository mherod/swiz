import { LRUCache } from "lru-cache"
import { ghJson } from "../../../git-helpers.ts"

export const GH_QUERY_TTL_MS = 20_000

interface GhCacheEntry {
  value: unknown
  expiresAt: number
}

type GhFetcher = (args: string[], cwd: string) => Promise<unknown>

export class GhQueryCache {
  private entries = new LRUCache<string, GhCacheEntry>({ max: 500 })
  private fetcher: GhFetcher
  private _hits = 0
  private _misses = 0

  constructor(fetcher?: GhFetcher) {
    this.fetcher = fetcher ?? ((args, cwd) => ghJson(args, cwd))
  }

  private key(args: string[], cwd: string): string {
    return `${cwd}\x00${args.join("\x00")}`
  }

  async get(
    args: string[],
    cwd: string,
    ttlMs: number = GH_QUERY_TTL_MS
  ): Promise<{ hit: boolean; value: unknown }> {
    const k = this.key(args, cwd)
    const entry = this.entries.get(k)
    if (entry && entry.expiresAt > Date.now()) {
      this._hits++
      return { hit: true, value: entry.value }
    }
    this._misses++
    const value = await this.fetcher(args, cwd)
    this.entries.set(k, { value, expiresAt: Date.now() + Math.max(0, ttlMs) })
    return { hit: false, value }
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      if (k.startsWith(cwd)) this.entries.delete(k)
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

  get evictions(): number {
    return this.entries.size > 0 ? 0 : 0
  }
}
