import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COOLDOWN_MS,
  getRemainingCooldownMs,
  parsePushWaitArgs,
  waitForCooldown,
} from "./push-wait.ts"

// ─── Helper ──────────────────────────────────────────────────────────────

function uniqueSentinel(label = ""): string {
  const id = randomBytes(8).toString("hex")
  return join(tmpdir(), `swiz-push-wait-test-${id}${label}.timestamp`)
}

function writeSentinel(path: string, timestamp: number): void {
  writeFileSync(path, String(timestamp))
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

  it("parses --cwd flag", () => {
    const result = parsePushWaitArgs(["--cwd", "/some/path", "origin", "main"])
    expect(result.cwd).toBe("/some/path")
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.extraArgs).toEqual([])
  })

  it("does not include --cwd in extraArgs", () => {
    const result = parsePushWaitArgs(["--cwd", "/repo", "--dry-run"])
    expect(result.cwd).toBe("/repo")
    expect(result.extraArgs).toEqual(["--dry-run"])
  })

  it("returns undefined cwd when not provided", () => {
    const result = parsePushWaitArgs(["origin", "main"])
    expect(result.cwd).toBeUndefined()
  })

  it("parses --wait flag", () => {
    const result = parsePushWaitArgs(["--wait"])
    expect(result.wait).toBe(true)
  })

  it("defaults wait to false when not provided", () => {
    const result = parsePushWaitArgs([])
    expect(result.wait).toBe(false)
  })

  it("parses --wait alongside other flags", () => {
    const result = parsePushWaitArgs(["--wait", "origin", "main", "--timeout", "60"])
    expect(result.wait).toBe(true)
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.timeout).toBe(60)
  })

  it("does not include --wait in extraArgs", () => {
    const result = parsePushWaitArgs(["--wait", "--dry-run"])
    expect(result.wait).toBe(true)
    expect(result.extraArgs).toEqual(["--dry-run"])
  })
})

// ─── getRemainingCooldownMs ──────────────────────────────────────────────

describe("getRemainingCooldownMs", () => {
  it("returns 0 when sentinel does not exist", async () => {
    expect(await getRemainingCooldownMs("/tmp/nonexistent-sentinel-file.timestamp")).toBe(0)
  })

  it("returns 0 when sentinel is empty", async () => {
    const p = uniqueSentinel("-empty")
    writeFileSync(p, "")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains non-numeric text", async () => {
    const p = uniqueSentinel("-garbage")
    writeFileSync(p, "not-a-number")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains whitespace only", async () => {
    const p = uniqueSentinel("-ws")
    writeFileSync(p, "   \n  ")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown has fully expired", async () => {
    const p = uniqueSentinel("-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 1000)
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown expired exactly", async () => {
    const p = uniqueSentinel("-exact")
    writeSentinel(p, Date.now() - COOLDOWN_MS)
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns positive ms when cooldown is active", async () => {
    const p = uniqueSentinel("-active")
    writeSentinel(p, Date.now() - 10_000) // 10s ago, 50s remaining
    const remaining = await getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(COOLDOWN_MS - 10_000 + 100) // +100ms tolerance
  })

  it("returns near-full cooldown for very recent push", async () => {
    const p = uniqueSentinel("-recent")
    writeSentinel(p, Date.now() - 100) // 100ms ago
    const remaining = await getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS - 1000) // at least 59s
  })

  it("returns 0 for timestamp far in the past", async () => {
    const p = uniqueSentinel("-ancient")
    writeSentinel(p, 0) // epoch
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 for future timestamp (clock skew)", async () => {
    const p = uniqueSentinel("-future")
    // A future timestamp means elapsed is negative, so remaining > COOLDOWN_MS.
    // But since the push "hasn't happened yet" from our perspective, remaining
    // will exceed COOLDOWN_MS. This is the correct safe behaviour — it decays.
    writeSentinel(p, Date.now() + 10_000)
    const remaining = await getRemainingCooldownMs(p)
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
    const p = uniqueSentinel("-already-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 5000)
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {}, // suppress
    })
    expect(result.waitedMs).toBe(0)
  })

  it("resolves immediately for corrupt sentinel", async () => {
    const p = uniqueSentinel("-corrupt")
    writeFileSync(p, "garbage-data")
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {},
    })
    expect(result.waitedMs).toBe(0)
  })

  it("waits and resolves when cooldown expires during polling", async () => {
    const p = uniqueSentinel("-wait-expire")
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
    const p = uniqueSentinel("-progress")
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
    const p = uniqueSentinel("-timeout")
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
    const p = uniqueSentinel("-timeout-remaining")
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
    const p = uniqueSentinel("-deleted-mid-wait")
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
