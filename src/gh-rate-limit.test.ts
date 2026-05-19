import { beforeAll, describe, expect, test } from "bun:test"
import { acquireGhSlot, getGhRateLimitStats } from "./gh-rate-limit.ts"

const THROTTLE_FILE = "/tmp/swiz-gh-rate-limit.log"

describe("gh-rate-limit", () => {
  beforeAll(async () => {
    await Bun.write(THROTTLE_FILE, "")
  })

  test("acquireGhSlot records a request timestamp", async () => {
    const before = await getGhRateLimitStats()
    await acquireGhSlot()
    const after = await getGhRateLimitStats()
    expect(after.used).toBeGreaterThanOrEqual(before.used + 1)
  })

  test("getGhRateLimitStats reports correct budget structure", async () => {
    await acquireGhSlot()
    const stats = await getGhRateLimitStats()
    expect(stats.limit).toBe(4500)
    expect(stats.remaining).toBe(stats.limit - stats.used)
    expect(stats.used).toBeGreaterThan(0)
    expect(stats.remaining).toBeLessThan(4500)
  })

  test("expired timestamps are excluded from usage count", async () => {
    // Write a file with only an old timestamp, then check stats
    const oldTs = Date.now() - 2 * 60 * 60 * 1000
    await Bun.write(THROTTLE_FILE, `${oldTs}\n`)

    const stats = await getGhRateLimitStats()
    expect(stats.used).toBe(0)
    expect(stats.remaining).toBe(4500)
  })

  test("acquireGhSlot returns immediately when under budget", async () => {
    const start = Date.now()
    await acquireGhSlot()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })
})
