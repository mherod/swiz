import { describe, expect, it } from "vitest"
import { parseCiWaitArgs } from "./ci-wait.ts"

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
