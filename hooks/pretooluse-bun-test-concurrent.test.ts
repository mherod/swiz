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
  void proc.stdin.write(payload)
  void proc.stdin.end()
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

  test("allows bun test with a single test file (--concurrent unnecessary)", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --reporter=dots")
    expect(result.decision).toBeUndefined()
  })

  test("allows bun test with --concurrent", async () => {
    const result = await runHook("bun test --concurrent")
    expect(result.decision).toBeUndefined()
  })

  test("allows bun test with --concurrent=<value>", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent=4")
    expect(result.decision).toBeUndefined()
  })

  test("allows chained single-file bun test without --concurrent", async () => {
    const result = await runHook(
      "bun test --concurrent hooks/a.test.ts && bun test hooks/b.test.ts"
    )
    expect(result.decision).toBeUndefined()
  })

  test("ignores non-bash tools", async () => {
    const result = await runHook("bun test", { toolName: "Edit" })
    expect(result.decision).toBeUndefined()
  })

  test("ignores commands without bun test", async () => {
    const result = await runHook("git status")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file with stderr redirection", async () => {
    const result = await runHook("bun test src/commands/state.test.ts 2> /tmp/out.log")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file with stdout redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts > /tmp/out.log")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file with append redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts >> /tmp/combined.log")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file with 2>&1 redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts 2>&1 > /tmp/combined.log")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file piped to tee", async () => {
    const result = await runHook("bun test src/foo.test.ts | tee /tmp/out.log")
    expect(result.decision).toBeUndefined()
  })

  test("allows single test file with multiple redirections", async () => {
    const result = await runHook("bun test src/foo.test.ts > /tmp/out.log 2> /tmp/err.log")
    expect(result.decision).toBeUndefined()
  })

  test("blocks multi-file bun test without --concurrent", async () => {
    const result = await runHook("bun test src/foo.test.ts src/bar.test.ts")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--concurrent")
  })

  test("blocks glob pattern bun test without --concurrent", async () => {
    const result = await runHook("bun test src/")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--concurrent")
  })
})
