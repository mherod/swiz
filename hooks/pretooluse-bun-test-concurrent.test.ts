import { describe, expect, test } from "bun:test"

async function runHook(
  command: string,
  opts: { toolName?: string } = {}
): Promise<{ decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: opts.toolName ?? "Bash",
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-bun-test-concurrent.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) return {}
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

describe("pretooluse-bun-test-concurrent", () => {
  test("blocks plain bun test", async () => {
    const result = await runHook("bun test")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--concurrent")
  })

  test("blocks bun test without --concurrent even with other flags", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --reporter=dots")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("hooks/foo.test.ts --reporter=dots")
  })

  test("allows bun test with --concurrent", async () => {
    const result = await runHook("bun test --concurrent")
    expect(result.decision).toBeUndefined()
  })

  test("allows bun test with --concurrent=<value>", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent=4")
    expect(result.decision).toBeUndefined()
  })

  test("blocks chained invocation when one bun test is missing --concurrent", async () => {
    const result = await runHook(
      "bun test --concurrent hooks/a.test.ts && bun test hooks/b.test.ts"
    )
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("hooks/b.test.ts")
  })

  test("ignores non-bash tools", async () => {
    const result = await runHook("bun test", { toolName: "Edit" })
    expect(result.decision).toBeUndefined()
  })

  test("ignores commands without bun test", async () => {
    const result = await runHook("git status")
    expect(result.decision).toBeUndefined()
  })

  test("inserts --concurrent before stderr redirection", async () => {
    const result = await runHook("bun test src/commands/state.test.ts 2> /tmp/out.log")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain(
      "bun test src/commands/state.test.ts --concurrent 2> /tmp/out.log"
    )
  })

  test("inserts --concurrent before stdout redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts > /tmp/out.log")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun test src/foo.test.ts --concurrent > /tmp/out.log")
  })

  test("inserts --concurrent before append redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts >> /tmp/combined.log")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun test src/foo.test.ts --concurrent >> /tmp/combined.log")
  })
})
