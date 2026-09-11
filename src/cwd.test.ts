import { describe, expect, test } from "bun:test"
import { resolveShellCwd } from "./cwd.ts"

describe("shell cwd policy", () => {
  test.each([
    [{ workdir: "/target", cwd: "/ignored" }, "/target", "tool_input.workdir"],
    [{ workdir: "../target" }, "/target", "tool_input.workdir"],
    [{ cwd: "/target" }, "/target", "tool_input.cwd"],
    [{ workdir: "", cwd: "/target" }, "/target", "tool_input.cwd"],
    [{ workdir: "  " }, "/session", "session cwd"],
    [{ workdir: 42 }, "/session", "session cwd"],
  ])("resolves %j with source %s %s", (tool_input, cwd, source) => {
    expect(resolveShellCwd({ cwd: "/session", tool_input })).toEqual({
      cwd,
      source,
      sessionCwd: "/session",
    })
  })

  test("falls back to process cwd when session cwd is absent", () => {
    expect(resolveShellCwd({})).toEqual({
      cwd: process.cwd(),
      sessionCwd: process.cwd(),
      source: "process cwd",
    })
  })
})
