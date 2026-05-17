import { describe, expect, it } from "vitest"
import { discoverRunId, expandSha, parseCiWaitArgs } from "./ci-wait.ts"

// ─── expandSha ────────────────────────────────────────────────────────────

describe("expandSha", () => {
  it("returns full SHA unchanged without calling git", async () => {
    const fullSha = "a".repeat(40)
    const result = await expandSha(fullSha)
    expect(result).toBe(fullSha)
  })

  it("returns original SHA when git rev-parse fails (not a git SHA)", async () => {
    const notASha = "notarealsha"
    const result = await expandSha(notASha)
    // Falls back to original when rev-parse returns non-40-char or errors
    expect(result).toBe(notASha)
  })

  it("expands a valid short SHA to 40 characters", async () => {
    // Use HEAD which is always resolvable in the repo
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const shortSha = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (!shortSha) return // skip if not in a git repo

    const result = await expandSha(shortSha)
    expect(result).toHaveLength(40)
  })
})

// ─── parseCiWaitArgs ──────────────────────────────────────────────────────

describe("parseCiWaitArgs", () => {
  it("parses a bare commit SHA", () => {
    const result = parseCiWaitArgs(["abc123"])
    expect(result.commitSha).toBe("abc123")
    expect(result.timeout).toBe(300)
  })

  it("parses --timeout flag", () => {
    const result = parseCiWaitArgs(["abc123", "--timeout", "60"])
    expect(result.commitSha).toBe("abc123")
    expect(result.timeout).toBe(60)
  })

  it("parses -t shorthand", () => {
    const result = parseCiWaitArgs(["-t", "120", "def456"])
    expect(result.commitSha).toBe("def456")
    expect(result.timeout).toBe(120)
  })

  it("throws when no commit SHA provided", () => {
    expect(() => parseCiWaitArgs([])).toThrow("Commit SHA is required")
    expect(() => parseCiWaitArgs(["--timeout", "60"])).toThrow("Commit SHA is required")
  })

  it("throws for non-positive timeout", () => {
    expect(() => parseCiWaitArgs(["abc", "--timeout", "0"])).toThrow("positive number")
    expect(() => parseCiWaitArgs(["abc", "--timeout", "-5"])).toThrow("positive number")
  })

  it("throws for non-numeric timeout", () => {
    expect(() => parseCiWaitArgs(["abc", "--timeout", "abc"])).toThrow("positive number")
  })
})

// ─── discoverRunId ────────────────────────────────────────────────────────

describe("discoverRunId", () => {
  it("returns the run ID on the first successful attempt", async () => {
    const findFn = async (_sha: string) => 42
    const result = await discoverRunId("abc123", { findFn, intervalMs: 0 })
    expect(result).toBe(42)
  })

  it("returns null after exhausting all attempts", async () => {
    const calls: number[] = []
    const findFn = async (_sha: string) => {
      calls.push(1)
      return null
    }
    const result = await discoverRunId("abc123", { maxAttempts: 3, findFn, intervalMs: 0 })
    expect(result).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it("returns run ID found on the third attempt", async () => {
    let attempt = 0
    const findFn = async (_sha: string) => {
      attempt++
      return attempt === 3 ? 99 : null
    }
    const result = await discoverRunId("abc123", { maxAttempts: 3, findFn, intervalMs: 0 })
    expect(result).toBe(99)
    expect(attempt).toBe(3)
  })

  it("calls onWaiting between failed attempts", async () => {
    const waitingCalls: [number, number][] = []
    let attempt = 0
    const findFn = async (_sha: string) => {
      attempt++
      return attempt === 2 ? 7 : null
    }
    await discoverRunId("abc123", {
      maxAttempts: 3,
      findFn,
      intervalMs: 0,
      onWaiting: (a, max) => waitingCalls.push([a, max]),
    })
    expect(waitingCalls).toEqual([[1, 3]])
  })

  it("does not sleep after the last failed attempt", async () => {
    const sleeps: number[] = []
    const findFn = async (_sha: string) => null
    await discoverRunId("abc123", {
      maxAttempts: 2,
      findFn,
      intervalMs: 0,
      onWaiting: (a) => sleeps.push(a),
    })
    // Only 1 sleep between attempt 1 and 2; no sleep after attempt 2
    expect(sleeps).toHaveLength(1)
  })
})
