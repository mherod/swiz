import { describe, expect, it } from "bun:test"
import { WorkerPool } from "./worker-pool.ts"

/** Exits quickly when speak is off / payload is empty (see posttooluse-speak-narrator.ts). */
const FAST_ASYNC_HOOK = "posttooluse-speak-narrator.ts"

describe("WorkerPool", () => {
  it("drains when queued jobs exceed worker count", async () => {
    const pool = new WorkerPool()
    try {
      await pool.initialize()
      const payload = "{}"
      const total = 16
      const t0 = performance.now()
      await Promise.all(
        Array.from({ length: total }, () => pool.runHook(FAST_ASYNC_HOOK, payload, 10))
      )
      expect(performance.now() - t0).toBeLessThan(60_000)
    } finally {
      pool.terminate()
    }
  }, 90_000)

  it("drains many concurrent runHook calls without lost or duplicate completions (#438)", async () => {
    const pool = new WorkerPool()
    try {
      await pool.initialize()
      const payload = "{}"
      const total = 100
      const results = await Promise.all(
        Array.from({ length: total }, () => pool.runHook(FAST_ASYNC_HOOK, payload, 10))
      )
      expect(results).toHaveLength(total)
      const ok = new Set(["success", "no-output"])
      for (const res of results) {
        expect(ok.has(res.execution.status)).toBe(true)
      }
    } finally {
      pool.terminate()
    }
  }, 120_000)
})
