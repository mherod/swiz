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
  await proc.stdin.write(payload)
  await proc.stdin.end()
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
    expect(result.decision).toBe("allow")
  })

  test("allows bun test with --concurrent", async () => {
    const result = await runHook("bun test --concurrent")
    expect(result.decision).toBe("allow")
  })

  test("blocks single file with --concurrent", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Don't use `--concurrent`")
  })

  test("blocks single file with --concurrent=<value>", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent=4")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Don't use `--concurrent`")
  })

  test("allows chained: multi-file with --concurrent then single-file without", async () => {
    const result = await runHook("bun test --concurrent && bun test hooks/b.test.ts")
    expect(result.decision).toBe("allow")
  })

  test("ignores non-bash tools", async () => {
    const result = await runHook("bun test", { toolName: "Edit" })
    expect(result.decision).toBeUndefined()
  })

  test("ignores commands without bun test", async () => {
    const result = await runHook("git status")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with stderr redirection", async () => {
    const result = await runHook("bun test src/commands/state.test.ts 2> /tmp/out.log")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with stdout redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts > /tmp/out.log")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with append redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts >> /tmp/combined.log")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with 2>&1 redirection", async () => {
    const result = await runHook("bun test src/foo.test.ts 2>&1 > /tmp/combined.log")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file piped to tee", async () => {
    const result = await runHook("bun test src/foo.test.ts | tee /tmp/out.log")
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with timeout piped to tail", async () => {
    const result = await runHook(
      "bun test src/commands/memory.test.ts --timeout 30000 2>&1 | tail -50"
    )
    expect(result.decision).toBe("allow")
  })

  test("allows single test file with multiple redirections", async () => {
    const result = await runHook("bun test src/foo.test.ts > /tmp/out.log 2> /tmp/err.log")
    expect(result.decision).toBe("allow")
  })

  test("blocks single file with --concurrent and suggests removal", async () => {
    const result = await runHook("bun test src/foo.test.ts --concurrent --timeout 5000")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun test src/foo.test.ts --timeout 5000")
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
