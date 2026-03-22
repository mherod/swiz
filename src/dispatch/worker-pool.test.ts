import { afterEach, describe, expect, it } from "bun:test"
import { WorkerPool } from "./worker-pool.ts"

/** Exits quickly when speak is off / payload is empty (see posttooluse-speak-narrator.ts). */
const FAST_ASYNC_HOOK = "posttooluse-speak-narrator.ts"

describe("WorkerPool", () => {
  const pools: WorkerPool[] = []
  afterEach(() => {
    for (const p of pools) p.terminate()
    pools.length = 0
  })

  it("drains when queued jobs exceed worker count", async () => {
    const pool = new WorkerPool()
    pools.push(pool)
    await pool.initialize()
    const payload = "{}"
    const total = 16
    const t0 = performance.now()
    await Promise.all(
      Array.from({ length: total }, () => pool.runHook(FAST_ASYNC_HOOK, payload, 10))
    )
    expect(performance.now() - t0).toBeLessThan(60_000)
  }, 90_000)
})
