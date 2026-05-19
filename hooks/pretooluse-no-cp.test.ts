import { describe, expect, test } from "bun:test"
import { runHookInProcess } from "../src/utils/test-utils.ts"

async function runHook(
  command: string,
  toolName = "Bash"
): Promise<{ stdout: string; decision?: string; reason?: string }> {
  const result = await runHookInProcess("hooks/pretooluse-no-cp.ts", {
    tool_name: toolName,
    tool_input: { command },
  })

  const stdout = result.stdout.trim()
  if (!stdout) return { stdout }
  const parsed = JSON.parse(stdout)
  const hso = parsed.hookSpecificOutput
  return {
    stdout,
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

describe("pretooluse-no-cp", () => {
  test("blocks cp commands with ditto guidance", async () => {
    const result = await runHook("cp -R src dist")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("ditto")
  })

  test("blocks cp in chained commands", async () => {
    const result = await runHook("echo start && cp a b")
    expect(result.decision).toBe("deny")
  })

  test("allows non-cp commands", async () => {
    const result = await runHook("mv a b")
    expect(result.decision).toBe("allow")
  })

  test("ignores non-shell tools", async () => {
    const result = await runHook("cp a b", "Read")
    expect(result.stdout).toBe("")
  })
})
