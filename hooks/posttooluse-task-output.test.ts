/**
 * Unit tests for posttooluse-task-output.ts result-validation layer.
 *
 * Focuses on the BUN_COMPLETE_RE guard in detectFailure:
 *   - Complete output (contains "Ran N tests across M files.") → exact fail count
 *   - Truncated output (marker absent) → "unknown number of" instead
 *   - Exit 0 → hook does not block
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  decision?: string
  reason?: string
}

async function runHook(stdinPayload: Record<string, unknown>): Promise<HookResult> {
  const payload = JSON.stringify(stdinPayload)

  const proc = Bun.spawn(["bun", "hooks/posttooluse-task-output.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, ".."),
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined

  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim())
      decision = parsed.decision as string | undefined
      reason = parsed.reason as string | undefined
    } catch {}
  }

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, decision, reason }
}

function makePayload(output: string, exitCode: number, status = "completed") {
  return {
    tool_name: "TaskOutput",
    cwd: "/tmp",
    session_id: "test-session",
    tool_response: {
      output,
      exit_code: exitCode,
      status,
    },
  }
}

// Bun test output with completion marker
const COMPLETE_OUTPUT = `
bun test v1.3.10 (30e609e0)

src/commands/transcript.test.ts:
✗ parseDebugEvents > truncated output
  Error: expected to equal

 3 pass
 1 skip
 2 fail
 800 expect() calls
Ran 6 tests across 3 files. [1.23s]
`.trim()

// Bun test output WITHOUT completion marker (truncated mid-run)
const TRUNCATED_OUTPUT = `
bun test v1.3.10 (30e609e0)

src/commands/transcript.test.ts:
✗ parseDebugEvents > truncated output
  Error: expected to equal

 2 fail
`.trim()

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("posttooluse-task-output: result-validation guard", () => {
  test("complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("exit 0 does not block even when fail pattern is absent", async () => {
    const output = "4 pass\n0 fail\nRan 4 tests across 2 files."
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  test("non-TaskOutput tool_name is ignored", async () => {
    const payload = {
      tool_name: "Bash",
      cwd: "/tmp",
      session_id: "test-session",
      tool_response: { output: TRUNCATED_OUTPUT, exit_code: 1, status: "completed" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  test("in_progress task is skipped (not yet complete)", async () => {
    const result = await runHook(makePayload(TRUNCATED_OUTPUT, 1, "in_progress"))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  test("singular '1 test across 1 file.' marker is recognised as complete", async () => {
    const output = "bun test v1.3.10\n\n 0 pass\n 1 fail\nRan 1 test across 1 file. [0.01s]"
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("1 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("'N tests across 1 file.' (mixed plural/singular) is recognised as complete", async () => {
    const output = "bun test v1.3.10\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file. [0.02s]"
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("1 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("'1 test across N files.' (mixed singular/plural) is recognised as complete", async () => {
    const output = "bun test v1.3.10\n\n 0 pass\n 1 fail\nRan 1 test across 3 files. [0.02s]"
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("1 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })
})
