/**
 * Bounded, in-flight-deduplicated cache for keyed async lookups.
 *
 * The daemon accumulated six caches that each reimplemented the same shape: a
 * `CappedMap` of entries beside a parallel `inFlight` map so concurrent callers
 * for one key share a single computation instead of racing duplicate work. That
 * mechanism lives here once, so a new cache extends it rather than copying it a
 * seventh time (#752).
 *
 * Optional TTL support is the one capability the hand-rolled copies lacked.
 * Leave `ttlMs` unset for entries that stay valid until explicitly invalidated —
 * that is the behaviour the existing daemon caches rely on.
 */

import { CappedMap } from "./capped-map.ts"

/** Default entry ceiling — matches the cap every hand-rolled daemon cache used. */
const DEFAULT_MAX_SIZE = 200

interface CacheEntry<V> {
  value: V
  storedAt: number
}

export interface KeyedAsyncCacheOptions<V> {
  /** Hard entry ceiling before LRU eviction. Defaults to 200. */
  maxSize?: number
  /** Entry lifetime in ms. Omit for entries that never expire on their own. */
  ttlMs?: number
  /**
   * Whether a computed value is worth caching. Defaults to rejecting nullish
   * values, so a failed lookup is retried rather than memoised as a miss.
   */
  shouldCache?: (value: V) => boolean
  /** Clock seam so TTL expiry is testable without sleeping. Defaults to `Date.now`. */
  now?: () => number
}

export class KeyedAsyncCache<V> {
  private readonly entries: CappedMap<string, CacheEntry<V>>
  private readonly inFlight = new Map<string, Promise<V>>()
  private readonly ttlMs: number | undefined
  private readonly shouldCache: (value: V) => boolean
  private readonly now: () => number

  constructor(options: KeyedAsyncCacheOptions<V> = {}) {
    this.entries = new CappedMap<string, CacheEntry<V>>(options.maxSize ?? DEFAULT_MAX_SIZE)
    this.ttlMs = options.ttlMs
    this.shouldCache = options.shouldCache ?? ((value) => value != null)
    this.now = options.now ?? Date.now
  }

  /**
   * Return the cached value for `key`, joining an in-flight computation or
   * starting one via `compute` when there is no live entry.
   */
  async get(key: string, compute: (key: string) => Promise<V>): Promise<V> {
    const cached = this.peek(key)
    if (cached !== undefined) return cached

    const inflight = this.inFlight.get(key)
    if (inflight) return inflight

    // Assign to inFlight before awaiting so a concurrent caller arriving during
    // the first tick joins this computation instead of starting a second one.
    const computation = compute(key).then(
      (value) => {
        this.inFlight.delete(key)
        if (this.shouldCache(value)) {
          this.entries.set(key, { value, storedAt: this.now() })
        }
        return value
      },
      (err) => {
        // A rejected computation must not linger and poison later callers.
        this.inFlight.delete(key)
        throw err
      }
    )
    this.inFlight.set(key, computation)
    return computation
  }

  /** Read a live cached value without computing. Expired entries are evicted. */
  peek(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.ttlMs !== undefined && this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  /** Seed a value directly, bypassing `compute`. */
  set(key: string, value: V): void {
    this.entries.set(key, { value, storedAt: this.now() })
  }

  invalidate(key: string): void {
    this.entries.delete(key)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  /** Live entry count. Expired-but-unevicted entries are still counted. */
  get size(): number {
    return this.entries.size
  }
}
