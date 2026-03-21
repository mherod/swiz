import { describe, expect, test } from "bun:test"
import { runBashHook } from "./test-utils.ts"

const HOOK = "hooks/pretooluse-no-mixed-tool-calls.ts"

function runHook(command: string, opts: { toolName?: string } = {}) {
  return runBashHook(HOOK, command, opts)
}

describe("pretooluse-no-mixed-tool-calls", () => {
  test("blocks a Bash command that starts with TaskCreate", async () => {
    const result = await runHook(
      "TaskCreate 2>/dev/null; swiz tasks 2>/dev/null | head -20 || true"
    )
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskCreate")
    expect(result.reason).toContain("not a terminal command")
    expect(result.reason).toContain("swiz tasks")
  })

  test("blocks nested Bash(...) shell tool syntax", async () => {
    const result = await runHook("Bash(git status)")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Bash")
    expect(result.reason).toContain("Do not nest")
  })

  test("blocks Read used as a shell command", async () => {
    const result = await runHook("Read src/index.ts")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Read")
    expect(result.reason).toContain("tool interface")
  })

  test("blocks agent alias after env assignments", async () => {
    const result = await runHook("DEBUG=1 update_plan")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("update_plan")
  })

  test("allows normal shell commands", async () => {
    const result = await runHook("swiz tasks 2>/dev/null | head -20 || true")
    expect(result.decision).toBe("allow")
  })

  test("does not trigger on tool names used as plain arguments", async () => {
    const result = await runHook("echo TaskCreate")
    expect(result.decision).toBe("allow")
  })

  test("ignores non-shell tools", async () => {
    const result = await runHook("TaskCreate", { toolName: "Read" })
    expect(result.stdout).toBe("")
  })
})
