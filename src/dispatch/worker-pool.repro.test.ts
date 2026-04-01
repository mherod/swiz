import { afterEach, describe, expect, it } from "bun:test"
import { WorkerPool } from "./worker-pool.ts"

const FAST_ASYNC_HOOK = "posttooluse-speak-narrator.ts"

describe("WorkerPool Race Condition", () => {
  const pools: WorkerPool[] = []
  afterEach(() => {
    for (const p of pools) p.terminate()
    pools.length = 0
  })

  it("fails when multiple processQueue calls occur simultaneously", async () => {
    const pool = new WorkerPool()
    pools.push(pool)
    await pool.initialize()

    const payload = "{}"
    const total = 4

    // We try to trigger multiple processQueue calls by running multiple runHook calls
    // which each call processQueue.
    // If processQueue is not re-entrant safe, it might lead to issues.

    const results = await Promise.all(
      Array.from({ length: total }, () => pool.runHook(FAST_ASYNC_HOOK, payload, 10))
    )

    expect(results.length).toBe(total)
    for (const res of results) {
      // "success" means output parsed successfully; "no-output" means empty {} which is also fine
      // for this specific hook since it only speaks if settings.speak is true.
      expect(["success", "no-output"]).toContain(res.execution.status)
    }
  })
})
