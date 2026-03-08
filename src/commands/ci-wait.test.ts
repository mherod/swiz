import { describe, expect, it } from "vitest"
import { expandSha, parseCiWaitArgs } from "./ci-wait.ts"

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
