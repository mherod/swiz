import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"

async function runHook(
  command: string,
  opts: { toolName?: string } = {}
): Promise<{ decision?: string; reason?: string }> {
  return await runBashHook("hooks/pretooluse-bun-test-concurrent.ts", command, opts)
}

describe("pretooluse-bun-test-concurrent", () => {
  test("blocks plain bun test", async () => {
    const result = await runHook("bun test")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--parallel=4")
  })

  test("allows bun test with a single test file", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --reporter=dots")
    expect(result.decision).toBe("allow")
  })

  test("allows bun test with bounded file workers", async () => {
    const result = await runHook("bun test --parallel=4")
    expect(result.decision).toBe("allow")
  })

  test("blocks --concurrent for a single file", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("makes every test concurrent")
  })

  test("blocks --concurrent=<value>", async () => {
    const result = await runHook("bun test hooks/foo.test.ts --concurrent=4")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("makes every test concurrent")
  })

  test("allows chained bounded multi-file then focused single-file runs", async () => {
    const result = await runHook("bun test --parallel=4 && bun test hooks/b.test.ts")
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

  test("allows quoted filter argument containing bun test", async () => {
    const result = await runHook('rg -v "bun test" some-file.ts')
    expect(result.decision).toBe("allow")
  })

  test("allows quoted pipe before bun test", async () => {
    const result = await runHook('rg "|bun test" hooks/pretooluse-bun-test-concurrent.ts')
    expect(result.decision).toBe("allow")
  })

  test("allows quoted semicolon before bun test", async () => {
    const result = await runHook('grep "; bun test" hooks/*.ts')
    expect(result.decision).toBe("allow")
  })

  test("blocks actual bun test after a pipe", async () => {
    const result = await runHook("rg foo hooks | bun test")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--parallel=4")
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

  test("blocks a single file with worker parallelism", async () => {
    const result = await runHook("bun test src/foo.test.ts --parallel=4 --timeout 5000")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun test src/foo.test.ts --timeout 5000")
  })

  test("blocks multi-file bun test without bounded workers", async () => {
    const result = await runHook("bun test src/foo.test.ts src/bar.test.ts")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--parallel=4")
  })

  test("blocks glob pattern bun test without bounded workers", async () => {
    const result = await runHook("bun test src/")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("--parallel=4")
  })

  test("blocks an unbounded --parallel flag", async () => {
    const result = await runHook("bun test --parallel")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("between 1 and 8")
  })

  test("blocks an excessive worker count", async () => {
    const result = await runHook("bun test --parallel=20")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("between 1 and 8")
  })
})
