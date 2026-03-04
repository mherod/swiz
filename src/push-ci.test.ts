import { describe, expect, it } from "bun:test"
import { parsePushCiArgs } from "./commands/push-ci.ts"

describe("parsePushCiArgs", () => {
  it("defaults to origin/current-branch with standard timeouts", () => {
    const result = parsePushCiArgs([])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("")
    expect(result.cooldownTimeout).toBe(120)
    expect(result.ciTimeout).toBe(300)
    expect(result.cwd).toBeUndefined()
  })

  it("parses remote and branch positional args", () => {
    const result = parsePushCiArgs(["upstream", "feature/my-branch"])
    expect(result.remote).toBe("upstream")
    expect(result.branch).toBe("feature/my-branch")
  })

  it("parses --ci-timeout flag", () => {
    const result = parsePushCiArgs(["origin", "main", "--ci-timeout", "600"])
    expect(result.ciTimeout).toBe(600)
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
  })

  it("parses --timeout flag for cooldown", () => {
    const result = parsePushCiArgs(["--timeout", "60"])
    expect(result.cooldownTimeout).toBe(60)
  })

  it("parses --cwd flag", () => {
    const result = parsePushCiArgs(["--cwd", "/tmp/repo"])
    expect(result.cwd).toBe("/tmp/repo")
  })

  it("parses all flags together", () => {
    const result = parsePushCiArgs([
      "origin",
      "main",
      "--timeout",
      "30",
      "--ci-timeout",
      "120",
      "--cwd",
      "/tmp/repo",
    ])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.cooldownTimeout).toBe(30)
    expect(result.ciTimeout).toBe(120)
    expect(result.cwd).toBe("/tmp/repo")
  })

  it("throws on invalid ci-timeout", () => {
    expect(() => parsePushCiArgs(["--ci-timeout", "abc"])).toThrow(
      "CI timeout must be a positive number"
    )
  })

  it("throws on negative ci-timeout", () => {
    expect(() => parsePushCiArgs(["--ci-timeout", "-5"])).toThrow(
      "CI timeout must be a positive number"
    )
  })
})
