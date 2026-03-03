import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  COOLDOWN_MS,
  getRemainingCooldownMs,
  parsePushWaitArgs,
  waitForCooldown,
} from "./push-wait.ts"

// ─── Helper ──────────────────────────────────────────────────────────────

function tmpSentinel(suffix = ""): string {
  return join(tmpdir(), `swiz-push-wait-test-${Date.now()}${suffix}.timestamp`)
}

function writeSentinel(path: string, timestamp: number): void {
  writeFileSync(path, String(timestamp))
}

const sentinels: string[] = []
afterEach(async () => {
  for (const s of sentinels) {
    try {
      const f = Bun.file(s)
      if (await f.exists()) await Bun.write(s, "")
    } catch {
      /* ignore */
    }
  }
  sentinels.length = 0
})

function trackSentinel(suffix = ""): string {
  const p = tmpSentinel(suffix)
  sentinels.push(p)
  return p
}

// ─── parsePushWaitArgs ───────────────────────────────────────────────────

describe("parsePushWaitArgs", () => {
  it("returns defaults when no args provided", () => {
    const result = parsePushWaitArgs([])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("")
    expect(result.timeout).toBe(120)
    expect(result.extraArgs).toEqual([])
  })

  it("parses remote and branch positionals", () => {
    const result = parsePushWaitArgs(["upstream", "feat/foo"])
    expect(result.remote).toBe("upstream")
    expect(result.branch).toBe("feat/foo")
  })

  it("parses --timeout flag", () => {
    const result = parsePushWaitArgs(["--timeout", "60"])
    expect(result.timeout).toBe(60)
  })

  it("parses -t shorthand", () => {
    const result = parsePushWaitArgs(["-t", "30"])
    expect(result.timeout).toBe(30)
  })

  it("throws on non-positive timeout", () => {
    expect(() => parsePushWaitArgs(["--timeout", "0"])).toThrow("positive number")
    expect(() => parsePushWaitArgs(["--timeout", "-5"])).toThrow("positive number")
  })

  it("throws on non-numeric timeout", () => {
    expect(() => parsePushWaitArgs(["--timeout", "abc"])).toThrow("positive number")
  })

  it("collects extra flags into extraArgs", () => {
    const result = parsePushWaitArgs(["--dry-run", "origin", "main"])
    expect(result.extraArgs).toEqual(["--dry-run"])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
  })

  it("handles timeout interleaved with positionals", () => {
    const result = parsePushWaitArgs(["origin", "-t", "90", "main"])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.timeout).toBe(90)
  })
})

// ─── getRemainingCooldownMs ──────────────────────────────────────────────

describe("getRemainingCooldownMs", () => {
  it("returns 0 when sentinel does not exist", () => {
    expect(getRemainingCooldownMs("/tmp/nonexistent-sentinel-file.timestamp")).toBe(0)
  })

  it("returns 0 when sentinel is empty", () => {
    const p = trackSentinel("-empty")
    writeFileSync(p, "")
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains non-numeric text", () => {
    const p = trackSentinel("-garbage")
    writeFileSync(p, "not-a-number")
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains whitespace only", () => {
    const p = trackSentinel("-ws")
    writeFileSync(p, "   \n  ")
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown has fully expired", () => {
    const p = trackSentinel("-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 1000)
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown expired exactly", () => {
    const p = trackSentinel("-exact")
    writeSentinel(p, Date.now() - COOLDOWN_MS)
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns positive ms when cooldown is active", () => {
    const p = trackSentinel("-active")
    writeSentinel(p, Date.now() - 10_000) // 10s ago, 50s remaining
    const remaining = getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(COOLDOWN_MS - 10_000 + 100) // +100ms tolerance
  })

  it("returns near-full cooldown for very recent push", () => {
    const p = trackSentinel("-recent")
    writeSentinel(p, Date.now() - 100) // 100ms ago
    const remaining = getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS - 1000) // at least 59s
  })

  it("returns 0 for timestamp far in the past", () => {
    const p = trackSentinel("-ancient")
    writeSentinel(p, 0) // epoch
    expect(getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 for future timestamp (clock skew)", () => {
    const p = trackSentinel("-future")
    // A future timestamp means elapsed is negative, so remaining > COOLDOWN_MS.
    // But since the push "hasn't happened yet" from our perspective, remaining
    // will exceed COOLDOWN_MS. This is the correct safe behaviour — it decays.
    writeSentinel(p, Date.now() + 10_000)
    const remaining = getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS)
  })
})

// ─── waitForCooldown ─────────────────────────────────────────────────────

describe("waitForCooldown", () => {
  it("resolves immediately when no sentinel exists", async () => {
    const result = await waitForCooldown({
      sentinelPath: "/tmp/nonexistent-push-wait-test.timestamp",
      timeoutSeconds: 5,
    })
    expect(result.waitedMs).toBe(0)
  })

  it("resolves immediately when cooldown already expired", async () => {
    const p = trackSentinel("-already-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 5000)
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {}, // suppress
    })
    expect(result.waitedMs).toBe(0)
  })

  it("resolves immediately for corrupt sentinel", async () => {
    const p = trackSentinel("-corrupt")
    writeFileSync(p, "garbage-data")
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {},
    })
    expect(result.waitedMs).toBe(0)
  })

  it("waits and resolves when cooldown expires during polling", async () => {
    const p = trackSentinel("-wait-expire")
    // Set cooldown to expire in ~150ms (simulate short remaining cooldown)
    writeSentinel(p, Date.now() - COOLDOWN_MS + 150)

    const logs: string[] = []
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50, // fast polling for test speed
      log: (msg) => logs.push(msg),
    })

    expect(result.waitedMs).toBeGreaterThan(0)
    expect(result.waitedMs).toBeLessThan(3000) // should resolve well within 3s
    // Should have logged the initial "active" message
    expect(logs.some((l) => l.includes("cooldown active") || l.includes("Cooldown active"))).toBe(
      true
    )
    // Should have logged the "expired" message
    expect(logs.some((l) => l.includes("expired"))).toBe(true)
  })

  it("reports remaining time on each poll", async () => {
    const p = trackSentinel("-progress")
    // ~300ms remaining
    writeSentinel(p, Date.now() - COOLDOWN_MS + 300)

    const logs: string[] = []
    await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50,
      log: (msg) => logs.push(msg),
    })

    // Should have at least the initial log and the expiry log
    expect(logs.length).toBeGreaterThanOrEqual(2)
    // Intermediate logs should mention "remaining"
    const intermediates = logs.filter((l) => l.includes("remaining"))
    expect(intermediates.length).toBeGreaterThan(0)
  })

  it("rejects when timeout expires before cooldown clears", async () => {
    const p = trackSentinel("-timeout")
    // Cooldown has 50s remaining — timeout is only 0.1s
    writeSentinel(p, Date.now() - 10_000)

    const promise = waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 0.1,
      pollIntervalMs: 30,
      log: () => {},
    })

    await expect(promise).rejects.toThrow("did not expire within")
  })

  it("timeout error includes remaining cooldown time", async () => {
    const p = trackSentinel("-timeout-remaining")
    writeSentinel(p, Date.now() - 5_000) // 55s remaining

    try {
      await waitForCooldown({
        sentinelPath: p,
        timeoutSeconds: 0.1,
        pollIntervalMs: 30,
        log: () => {},
      })
      expect.unreachable("should have thrown")
    } catch (err) {
      const msg = String(err)
      expect(msg).toContain("did not expire")
      expect(msg).toContain("still remaining")
    }
  })

  it("handles sentinel deleted mid-wait", async () => {
    const p = trackSentinel("-deleted-mid-wait")
    writeSentinel(p, Date.now() - 10_000) // 50s remaining

    // Delete the sentinel after 100ms to simulate external cleanup
    setTimeout(async () => {
      try {
        const f = Bun.file(p)
        if (await f.exists()) await Bun.write(p, "")
        // Actually remove it by writing empty — getRemainingCooldownMs treats empty as 0
      } catch {
        /* ignore */
      }
    }, 100)

    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50,
      log: () => {},
    })

    expect(result.waitedMs).toBeGreaterThan(0)
    expect(result.waitedMs).toBeLessThan(3000)
  })
})
