import { describe, expect, it } from "vitest"
import { parsePushWaitArgs } from "./push-wait.ts"

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
