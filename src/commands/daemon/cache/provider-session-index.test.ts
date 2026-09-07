import { describe, expect, test } from "bun:test"
import type { Session } from "../../../transcript-utils.ts"
import {
  PROVIDER_INDEX_MAX_DESCRIPTORS,
  PROVIDER_INDEX_MAX_KEYS,
  PROVIDER_INDEX_MAX_STALENESS_MS,
  ProviderSessionIndex,
  providerIndexKey,
} from "./provider-session-index.ts"

function session(id: string, mtime: number): Session {
  return {
    id,
    path: `/transcripts/${id}.jsonl`,
    mtime,
    provider: "claude",
    format: "jsonl",
  } as Session
}

/** Deterministic newest-first fixture, matching what findAllProviderSessions returns. */
const RESULT = [session("newest", 300), session("middle", 200), session("oldest", 100)]

interface Harness {
  index: ProviderSessionIndex
  /** How many underlying provider walks ran. */
  walks: () => number
  /** Advance the injected clock. */
  advance: (ms: number) => void
  /** Release a gated walk; only used by the gated harness. */
  release?: () => void
}

function harness(options: { gated?: boolean; result?: Session[] } = {}): Harness {
  let walks = 0
  let clock = 1_000
  let release: (() => void) | undefined
  const result = options.result ?? RESULT

  const index = new ProviderSessionIndex({
    now: () => clock,
    discover: async () => {
      walks++
      if (options.gated) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return result
    },
  })

  return {
    index,
    walks: () => walks,
    advance: (ms) => {
      clock += ms
    },
    release: () => release?.(),
  }
}

describe("provider discovery index", () => {
  test("twenty concurrent requests trigger exactly one provider walk", async () => {
    const h = harness({ gated: true })

    const pending = Array.from({ length: 20 }, () => h.index.get("/repo"))
    // All twenty are in flight against a single gated walk.
    await Promise.resolve()
    h.release?.()
    const results = await Promise.all(pending)

    expect(h.walks()).toBe(1)
    for (const result of results) {
      expect(result.map((s) => s.id)).toEqual(["newest", "middle", "oldest"])
    }
    expect(h.index.getMetrics().coalesced).toBeGreaterThan(0)
  })

  test("twenty unchanged poll cycles cause no additional walks", async () => {
    const h = harness()
    await h.index.get("/repo")
    expect(h.walks()).toBe(1)

    for (let i = 0; i < 20; i++) {
      // Well inside the staleness deadline, as a two-second dashboard poll would be.
      h.advance(100)
      await h.index.get("/repo")
    }

    expect(h.walks()).toBe(1)
    expect(h.index.getMetrics().hits).toBe(20)
  })

  test("an entry past the staleness deadline is refreshed on the next request", async () => {
    const h = harness()
    await h.index.get("/repo")
    expect(h.walks()).toBe(1)

    h.advance(PROVIDER_INDEX_MAX_STALENESS_MS - 1)
    await h.index.get("/repo")
    expect(h.walks()).toBe(1)

    // Control for the boundary: only on or after the deadline does a walk happen.
    h.advance(1)
    await h.index.get("/repo")
    expect(h.walks()).toBe(2)
    expect(h.index.getMetrics().staleRefreshes).toBe(1)
  })

  test("concurrent requests coalesce the staleness refresh", async () => {
    const h = harness({ gated: true })
    const first = h.index.get("/repo")
    h.release?.()
    await first
    expect(h.walks()).toBe(1)

    h.advance(PROVIDER_INDEX_MAX_STALENESS_MS)
    const pending = Array.from({ length: 10 }, () => h.index.get("/repo"))
    await Promise.resolve()
    h.release?.()
    await Promise.all(pending)

    // One refresh serves all ten, not ten refreshes.
    expect(h.walks()).toBe(2)
  })

  test("different caller limits reuse one walk and keep prefix semantics", async () => {
    const h = harness()
    const all = await h.index.get("/repo")
    const two = await h.index.get("/repo", undefined, 2)
    const one = await h.index.get("/repo", undefined, 1)

    expect(h.walks()).toBe(1)
    expect(all.map((s) => s.id)).toEqual(["newest", "middle", "oldest"])
    expect(two.map((s) => s.id)).toEqual(["newest", "middle"])
    expect(one.map((s) => s.id)).toEqual(["newest"])
  })

  test("a limited read does not truncate the stored result", async () => {
    const h = harness()
    await h.index.get("/repo", undefined, 1)
    const all = await h.index.get("/repo")
    expect(all).toHaveLength(3)
    expect(h.walks()).toBe(1)
  })

  test("invalidation forces the next request to walk again", async () => {
    const h = harness()
    await h.index.get("/repo")
    h.index.invalidate("/repo")
    await h.index.get("/repo")

    expect(h.walks()).toBe(2)
    expect(h.index.getMetrics().invalidations).toBe(1)
  })

  test("invalidation during a walk is not overwritten by the in-flight result", async () => {
    // Otherwise a walk that started before the change would reinstate pre-change descriptors
    // over a newer watcher signal, and the index would serve stale data indefinitely.
    const h = harness({ gated: true })
    const pending = h.index.get("/repo")
    await Promise.resolve()
    h.index.invalidate("/repo")
    h.release?.()
    await pending

    // The invalidated entry must not have been repopulated by the walk that was already running.
    const second = h.index.get("/repo")
    await Promise.resolve()
    h.release?.()
    await second

    expect(h.walks()).toBe(2)
  })

  test("caller spelling of the same project shares one entry", async () => {
    const h = harness()
    await h.index.get("/repo")
    await h.index.get("/repo/")
    await h.index.get("/repo/./")
    await h.index.get("/repo/sub/..")

    expect(h.walks()).toBe(1)
    expect(providerIndexKey("/repo")).toBe(providerIndexKey("/repo/./"))
  })

  test("different homes are separate entries", async () => {
    const h = harness()
    await h.index.get("/repo", "/home/a")
    await h.index.get("/repo", "/home/b")
    expect(h.walks()).toBe(2)
    expect(providerIndexKey("/repo", "/home/a")).not.toBe(providerIndexKey("/repo", "/home/b"))
  })

  test("key count stays within the documented bound under stress", async () => {
    const h = harness({ result: [session("only", 1)] })
    for (let i = 0; i < PROVIDER_INDEX_MAX_KEYS * 2; i++) {
      await h.index.get(`/repo-${i}`)
    }
    expect(h.index.getMetrics().keys).toBeLessThanOrEqual(PROVIDER_INDEX_MAX_KEYS)
  })

  test("descriptor count stays within the documented bound under stress", async () => {
    // Each project returns 500 descriptors, so 40 projects would be 20,000 unbounded.
    const big = Array.from({ length: 500 }, (_, i) => session(`s${i}`, i))
    const h = harness({ result: big })
    for (let i = 0; i < 40; i++) {
      await h.index.get(`/repo-${i}`)
    }
    const metrics = h.index.getMetrics()
    expect(metrics.descriptors).toBeLessThanOrEqual(PROVIDER_INDEX_MAX_DESCRIPTORS)
    expect(metrics.keys).toBeLessThanOrEqual(PROVIDER_INDEX_MAX_KEYS)
  })

  test("a failed walk is not cached and the next request retries", async () => {
    let calls = 0
    const index = new ProviderSessionIndex({
      discover: async () => {
        calls++
        if (calls === 1) throw new Error("provider root unreadable")
        return RESULT
      },
    })

    await expect(index.get("/repo")).rejects.toThrow("provider root unreadable")
    const recovered = await index.get("/repo")

    expect(calls).toBe(2)
    expect(recovered).toHaveLength(3)
  })

  test("metrics expose counters only, never paths or session ids", async () => {
    const h = harness()
    await h.index.get("/repo")
    const serialized = JSON.stringify(h.index.getMetrics())
    expect(serialized).not.toContain("/repo")
    expect(serialized).not.toContain("newest")
    for (const value of Object.values(h.index.getMetrics())) {
      expect(typeof value).toBe("number")
    }
  })
})
