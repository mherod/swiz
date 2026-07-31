import { describe, expect, it } from "bun:test"
import { KeyedAsyncCache } from "./keyed-async-cache.ts"

describe("KeyedAsyncCache", () => {
  it("computes once and serves later reads from cache", async () => {
    const cache = new KeyedAsyncCache<string>()
    let calls = 0
    const compute = async (key: string) => {
      calls++
      return `value:${key}`
    }

    expect(await cache.get("a", compute)).toBe("value:a")
    expect(await cache.get("a", compute)).toBe("value:a")
    expect(calls).toBe(1)
  })

  it("deduplicates concurrent callers into a single computation", async () => {
    const cache = new KeyedAsyncCache<number>()
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const compute = async () => {
      calls++
      await gate
      return 42
    }

    const inflight = [cache.get("k", compute), cache.get("k", compute), cache.get("k", compute)]
    release?.()
    const results = await Promise.all(inflight)

    expect(results).toEqual([42, 42, 42])
    expect(calls).toBe(1)
  })

  it("recomputes after the TTL elapses", async () => {
    let clock = 1_000
    const cache = new KeyedAsyncCache<number>({ ttlMs: 100, now: () => clock })
    let calls = 0
    const compute = async () => {
      calls++
      return calls
    }

    expect(await cache.get("k", compute)).toBe(1)
    clock += 99
    expect(await cache.get("k", compute)).toBe(1)
    clock += 1
    expect(await cache.get("k", compute)).toBe(2)
    expect(calls).toBe(2)
  })

  it("never expires entries when no TTL is configured", async () => {
    let clock = 0
    const cache = new KeyedAsyncCache<number>({ now: () => clock })
    let calls = 0
    const compute = async () => {
      calls++
      return calls
    }

    expect(await cache.get("k", compute)).toBe(1)
    clock += 10_000_000
    expect(await cache.get("k", compute)).toBe(1)
    expect(calls).toBe(1)
  })

  it("does not cache nullish results, so a failed lookup is retried", async () => {
    const cache = new KeyedAsyncCache<string | null>()
    let calls = 0
    const compute = async () => {
      calls++
      return calls === 1 ? null : "recovered"
    }

    expect(await cache.get("k", compute)).toBeNull()
    expect(await cache.get("k", compute)).toBe("recovered")
    expect(calls).toBe(2)
  })

  it("honours a custom shouldCache predicate", async () => {
    const cache = new KeyedAsyncCache<number>({ shouldCache: (v) => v > 10 })
    let calls = 0
    const compute = async () => {
      calls++
      return calls * 10
    }

    expect(await cache.get("k", compute)).toBe(10) // not cached (not > 10)
    expect(await cache.get("k", compute)).toBe(20) // cached
    expect(await cache.get("k", compute)).toBe(20)
    expect(calls).toBe(2)
  })

  it("clears the in-flight entry when the computation rejects", async () => {
    const cache = new KeyedAsyncCache<string>()
    let calls = 0
    const compute = async () => {
      calls++
      if (calls === 1) throw new Error("probe failed")
      return "second"
    }

    await expect(cache.get("k", compute)).rejects.toThrow("probe failed")
    // A rejected computation must not poison the key.
    expect(await cache.get("k", compute)).toBe("second")
    expect(calls).toBe(2)
  })

  it("evicts least-recently-used entries beyond maxSize", async () => {
    const cache = new KeyedAsyncCache<string>({ maxSize: 2 })
    const compute = async (key: string) => `value:${key}`

    await cache.get("a", compute)
    await cache.get("b", compute)
    await cache.get("c", compute)

    expect(cache.size).toBe(2)
    expect(cache.peek("a")).toBeUndefined()
    expect(cache.peek("c")).toBe("value:c")
  })

  it("invalidates a single key without dropping the rest", async () => {
    const cache = new KeyedAsyncCache<string>()
    const compute = async (key: string) => `value:${key}`

    await cache.get("a", compute)
    await cache.get("b", compute)
    cache.invalidate("a")

    expect(cache.peek("a")).toBeUndefined()
    expect(cache.peek("b")).toBe("value:b")

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })
})
