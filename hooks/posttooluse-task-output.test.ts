/**
 * Unit tests for posttooluse-task-output.ts result-validation layer.
 *
 * Focuses on the BUN_COMPLETE_RE guard in detectFailure:
 *   - Complete output (contains "Ran N tests across M files.") → exact fail count
 *   - Truncated output (marker absent) → "unknown number of" instead
 *   - Exit 0 → hook does not block
 *
 * Also covers tool error handling:
 *   - InputValidationError (block as string) → block with type-correction message
 *   - "No task found" (expired record), no file → stderr + exit 0
 *   - "No task found" (expired record), file present → context injection
 *   - "No task found" (expired record), file present with exit-code pattern → block
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  decision?: string
  reason?: string
}

// ─── Output-file recovery helpers ────────────────────────────────────────────

/** UID of the running process — matches what tryReadOutputFile uses. */
const UID = process.getuid?.() ?? 501

/**
 * Construct the output-file path the hook will look up for a given cwd and task ID.
 * Mirrors the logic in tryReadOutputFile: /tmp/claude-{uid}/{cwd-encoded}/tasks/{id}.output
 */
function outputFilePath(cwd: string, taskId: string): string {
  const cwdKey = cwd.replace(/[/.]/g, "-")
  return `/tmp/claude-${UID}/${cwdKey}/tasks/${taskId}.output`
}

/** Write a fake output file at the path the hook will look up, returning the path. */
async function writeOutputFile(cwd: string, taskId: string, content: string): Promise<string> {
  const filePath = outputFilePath(cwd, taskId)
  const dir = filePath.substring(0, filePath.lastIndexOf("/"))
  await mkdir(dir, { recursive: true })
  await Bun.write(filePath, content)
  return filePath
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

  test("running task is skipped (not yet complete)", async () => {
    const result = await runHook(makePayload(TRUNCATED_OUTPUT, 1, "running"))
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

  test("ANSI-decorated completion line is recognised as complete", async () => {
    // Simulate bun embedding bold around numbers: "Ran ESC[1m4306ESC[0m tests across ESC[1m117ESC[0m files."
    const ESC = String.fromCharCode(27)
    const boldNum = (n: number) => `${ESC}[1m${n}${ESC}[0m`
    const output = [
      `bun test v1.3.10`,
      ``,
      `${ESC}[2m 0 pass${ESC}[0m`,
      `${ESC}[2m 2 fail${ESC}[0m`,
      `Ran ${boldNum(2)} tests across ${boldNum(1)} files. ${ESC}[2m[${ESC}[1m0.05s${ESC}[0m${ESC}[2m]${ESC}[0m`,
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("ANSI-decorated fail count is parsed correctly", async () => {
    // Bun dim-colours the '0 fail' line: ESC[2m 0 fail ESC[0m
    const ESC = String.fromCharCode(27)
    const output = [
      `bun test v1.3.10`,
      `${ESC}[2m 3 fail${ESC}[0m`,
      `Ran 3 tests across 2 files. [0.10s]`,
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("3 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })
})

// ─── Tool error handling ──────────────────────────────────────────────────────

/** CWD used for output-file recovery tests; encodes to a known key under /tmp. */
const RECOVERY_CWD = "/tmp/swiz-task-output-recovery-test"

describe("posttooluse-task-output: tool error handling", () => {
  // Track files written so we can clean up after the suite.
  const writtenFiles: string[] = []

  afterAll(async () => {
    for (const f of writtenFiles) {
      await rm(f, { force: true }).catch(() => {})
    }
    // Best-effort remove the test task directory.
    const taskDir = outputFilePath(RECOVERY_CWD, "x").replace(/\/[^/]+$/, "")
    await rm(taskDir, { recursive: true, force: true }).catch(() => {})
  })

  test("InputValidationError for block-as-string blocks with type-correction message", async () => {
    const errorResponse =
      "InputValidationError: TaskOutput failed due to the following issue:\n" +
      "The parameter `block` type is expected as `boolean` but provided as `string`"
    const payload = {
      tool_name: "TaskOutput",
      cwd: "/tmp",
      session_id: "test-session",
      tool_response: errorResponse,
      tool_input: { task_id: "abc123", block: "true" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("`block` parameter must be a boolean")
    expect(result.reason).toContain("block: true")
  })

  test("'No task found' with no output file blocks with actionable message naming the task ID", async () => {
    const payload = {
      tool_name: "TaskOutput",
      cwd: RECOVERY_CWD,
      session_id: "test-session",
      tool_response: "No task found with ID: nonexistent-task-xyz",
      tool_input: { task_id: "nonexistent-task-xyz" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("nonexistent-task-xyz")
    expect(result.reason).toContain("garbage-collected")
  })

  test("'No task found' with clean output file injects recovered content as context", async () => {
    const taskId = "recovered-task-clean-001"
    const fileContent = "4 pass\n0 fail\nRan 4 tests across 2 files. [0.50s]"
    const filePath = await writeOutputFile(RECOVERY_CWD, taskId, fileContent)
    writtenFiles.push(filePath)

    const payload = {
      tool_name: "TaskOutput",
      cwd: RECOVERY_CWD,
      session_id: "test-session",
      tool_response: `No task found with ID: ${taskId}`,
      tool_input: { task_id: taskId },
    }
    const result = await runHook(payload)
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
    // Should emit hookSpecificOutput with additionalContext, not a block decision
    const parsed = JSON.parse(result.stdout)
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("recovered from file")
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(taskId)
  })

  test("'No task found' with failing output file (exit status pattern) blocks", async () => {
    const taskId = "recovered-task-fail-001"
    const fileContent = "something went wrong\nexit status 1\n"
    const filePath = await writeOutputFile(RECOVERY_CWD, taskId, fileContent)
    writtenFiles.push(filePath)

    const payload = {
      tool_name: "TaskOutput",
      cwd: RECOVERY_CWD,
      session_id: "test-session",
      tool_response: `No task found with ID: ${taskId}`,
      tool_input: { task_id: taskId },
    }
    const result = await runHook(payload)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain(taskId)
    expect(result.reason).toContain("recovered from file")
  })
})
