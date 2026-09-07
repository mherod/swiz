import { describe, expect, it } from "bun:test"
import {
  DEFAULT_WORKER_POOL_SIZE,
  MAX_WORKER_POOL_SIZE,
  resolveWorkerPoolSize,
  WorkerPool,
} from "./worker-pool.ts"

const TEST_HOOK = "../src/dispatch/fixtures/worker-pool-hook.ts"

describe("resolveWorkerPoolSize", () => {
  it("uses a CPU-independent bounded default", () => {
    expect(resolveWorkerPoolSize({})).toBe(DEFAULT_WORKER_POOL_SIZE)
    expect(resolveWorkerPoolSize({ SWIZ_WORKER_POOL_SIZE: "invalid" })).toBe(
      DEFAULT_WORKER_POOL_SIZE
    )
  })

  it("accepts positive overrides and caps excessive values", () => {
    expect(resolveWorkerPoolSize({ SWIZ_WORKER_POOL_SIZE: "1" })).toBe(1)
    expect(resolveWorkerPoolSize({ SWIZ_WORKER_POOL_SIZE: "999" })).toBe(MAX_WORKER_POOL_SIZE)
  })
})

describe("WorkerPool", () => {
  it("drains when queued jobs exceed worker count", async () => {
    const pool = new WorkerPool({ size: 2 })
    try {
      await pool.initialize()
      const payload = "{}"
      const total = 16
      const t0 = performance.now()
      await Promise.all(Array.from({ length: total }, () => pool.runHook(TEST_HOOK, payload, 10)))
      expect(performance.now() - t0).toBeLessThan(60_000)
    } finally {
      pool.terminate()
    }
  }, 90_000)

  it("drains many concurrent runHook calls without lost or duplicate completions (#438)", async () => {
    const pool = new WorkerPool({ size: 2 })
    try {
      await pool.initialize()
      const total = 100
      const labels = Array.from({ length: total }, (_, index) => `job-${index}`)
      const results = await Promise.all(
        labels.map((label) => pool.runHook(TEST_HOOK, JSON.stringify({ label }), 10))
      )
      expect(results).toHaveLength(total)
      for (const res of results) {
        expect(res.execution.status).toBe("ok")
      }
      expect(results.map((result) => result.parsed?.systemMessage)).toEqual(labels)
      expect(pool.getMetrics()).toMatchObject({
        dispatchedJobs: total,
        queueDepth: 0,
        activeWorkers: 0,
      })
    } finally {
      pool.terminate()
    }
  }, 120_000)

  it("preserves FIFO queue ordering with one worker", async () => {
    const pool = new WorkerPool({ size: 1 })
    const completed: string[] = []
    try {
      const jobs = [{ delayMs: 40, label: "first" }, { label: "second" }, { label: "third" }].map(
        (payload) =>
          pool.runHook(TEST_HOOK, JSON.stringify(payload), 2).then((result) => {
            completed.push(String(result.parsed?.systemMessage))
          })
      )

      await Promise.all(jobs)
      expect(completed).toEqual(["first", "second", "third"])
      expect(pool.getMetrics().dispatchedJobs).toBe(3)
    } finally {
      pool.terminate()
    }
  })

  it("removes an aborted queued job without disturbing the active job", async () => {
    const pool = new WorkerPool({ size: 1 })
    const controller = new AbortController()
    try {
      const active = pool.runHook(TEST_HOOK, JSON.stringify({ delayMs: 60, label: "active" }), 2)
      const queued = pool.runHook(
        TEST_HOOK,
        JSON.stringify({ label: "queued" }),
        2,
        controller.signal
      )
      controller.abort()

      expect((await queued).execution.status).toBe("aborted")
      expect((await active).parsed?.systemMessage).toBe("active")
      expect(pool.getMetrics().queueDepth).toBe(0)
    } finally {
      pool.terminate()
    }
  })

  it("replaces a worker after a supervisor timeout and continues draining", async () => {
    const pool = new WorkerPool({ size: 1, supervisorGraceSec: -0.09 })
    try {
      await expect(
        pool.runHook(TEST_HOOK, JSON.stringify({ delayMs: 250, label: "slow" }), 0.1)
      ).rejects.toThrow("Supervisor timeout")
      expect(pool.getMetrics().replacements).toBe(1)

      const recovered = await pool.runHook(TEST_HOOK, JSON.stringify({ label: "recovered" }), 2)
      expect(recovered.parsed?.systemMessage).toBe("recovered")
    } finally {
      pool.terminate()
    }
  })

  it("rejects active work and releases workers during shutdown", async () => {
    const pool = new WorkerPool({ size: 1 })
    const active = pool.runHook(TEST_HOOK, JSON.stringify({ delayMs: 200, label: "active" }), 2)
    await Bun.sleep(10)

    pool.terminate()

    await expect(active).rejects.toThrow("Worker pool terminated")
    expect(pool.getMetrics()).toMatchObject({
      activeWorkers: 0,
      initialized: false,
      queueDepth: 0,
    })
  })
})
