import { describe, expect, test } from "bun:test"

async function runHook(
  command: string,
  toolName = "Bash"
): Promise<{ stdout: string; decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-cp.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  const stdout = out.trim()
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
    expect(result.stdout).toBe("")
  })

  test("ignores non-shell tools", async () => {
    const result = await runHook("cp a b", "Read")
    expect(result.stdout).toBe("")
  })
})
