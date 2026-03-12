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
import { claudeTaskOutputPath } from "../src/temp-paths.ts"

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
  return claudeTaskOutputPath(UID, cwdKey, taskId)
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
  void proc.stdin.write(payload)
  void proc.stdin.end()

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

// ─── Jest runner detection ────────────────────────────────────────────────────

// Jest output with completion marker
const JEST_COMPLETE_OUTPUT = `
FAIL src/auth/login.test.ts
  ● login > handles invalid credentials

    expect(received).toBe(expected)

    Expected: true
    Received: false

PASS src/auth/logout.test.ts

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 5 passed, 7 total
Snapshots:   0 total
Time:        1.234 s
`.trim()

// Jest output WITHOUT completion marker (truncated)
const JEST_TRUNCATED_OUTPUT = `
FAIL src/auth/login.test.ts
  ● login > handles invalid credentials

Tests:       2 failed
`.trim()

describe("posttooluse-task-output: Jest runner detection", () => {
  test("Jest complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(JEST_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("Jest truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(JEST_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("Jest exit 0 does not block", async () => {
    const output = "Tests:       5 passed, 5 total\nTest Suites: 1 passed, 1 total\nTime: 0.5s"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── Vitest runner detection ──────────────────────────────────────────────────

// Vitest output with completion marker
const VITEST_COMPLETE_OUTPUT = `
 FAIL  src/utils/format.test.ts > format > handles null input
AssertionError: expected null to equal ""

 Tests  3 failed | 4 passed (7)
 Duration  0.50s
`.trim()

// Vitest output WITHOUT completion marker (truncated)
const VITEST_TRUNCATED_OUTPUT = `
 FAIL  src/utils/format.test.ts > format > handles null input
AssertionError: expected null to equal ""

 Tests  3 failed
`.trim()

describe("posttooluse-task-output: Vitest runner detection", () => {
  test("Vitest complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(VITEST_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("3 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("Vitest truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(VITEST_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("Vitest exit 0 does not block", async () => {
    const output = " Tests  6 passed (6)\n Duration  0.30s"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── pytest runner detection ─────────────────────────────────────────────────

const PYTEST_COMPLETE_OUTPUT = `
FAILED tests/test_auth.py::test_login_invalid - AssertionError: expected True
FAILED tests/test_auth.py::test_token_expired - AssertionError: expected False

========================= 2 failed, 5 passed in 1.23s =========================
`.trim()

const PYTEST_TRUNCATED_OUTPUT = `
FAILED tests/test_auth.py::test_login_invalid - AssertionError: expected True

2 failed
`.trim()

describe("posttooluse-task-output: pytest runner detection", () => {
  test("pytest complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(PYTEST_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("pytest truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(PYTEST_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("pytest exit 0 does not block", async () => {
    const output = "========================= 5 passed in 0.50s ========================="
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── cargo test runner detection ─────────────────────────────────────────────

const CARGO_COMPLETE_OUTPUT = `
running 7 tests
test auth::test_valid_token ... ok
test auth::test_expired_token ... FAILED
test auth::test_missing_token ... FAILED

failures:

---- auth::test_expired_token stdout ----
thread 'auth::test_expired_token' panicked at 'assertion failed'

test result: FAILED. 5 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
`.trim()

describe("posttooluse-task-output: cargo test runner detection", () => {
  test("cargo test complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(CARGO_COMPLETE_OUTPUT, 101))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("cargo test exit 0 does not block", async () => {
    const output =
      "running 5 tests\ntest result: ok. 5 passed; 0 failed; 0 ignored; finished in 0.02s"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── go test runner detection ─────────────────────────────────────────────────

const GOTEST_COMPLETE_OUTPUT = `
--- FAIL: TestLogin (0.01s)
    auth_test.go:42: expected true, got false
--- FAIL: TestToken (0.00s)
    auth_test.go:67: token mismatch
FAIL
FAIL\tgithub.com/example/repo\t0.123s
`.trim()

const GOTEST_TRUNCATED_OUTPUT = `
--- FAIL: TestLogin (0.01s)
    auth_test.go:42: expected true, got false
--- FAIL: TestToken (0.00s)
    auth_test.go:67: token mismatch
`.trim()

describe("posttooluse-task-output: go test runner detection", () => {
  test("go test complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(GOTEST_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("go test truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(GOTEST_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("go test exit 0 does not block", async () => {
    const output = "ok  \tgithub.com/example/repo\t0.050s"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── Maven runner detection ───────────────────────────────────────────────────

const MAVEN_COMPLETE_OUTPUT = `
[INFO] Running com.example.AuthTest
[ERROR] Tests run: 7, Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 0.45 s <<< FAILURE! - in com.example.AuthTest
[ERROR] testLogin(com.example.AuthTest)  Time elapsed: 0.12 s  <<< FAILURE!
[INFO] BUILD FAILURE
`.trim()

const MAVEN_TRUNCATED_OUTPUT = `
[INFO] Running com.example.AuthTest
[ERROR] Tests run: 7, Failures: 2, Errors: 0, Skipped: 0
`.trim()

describe("posttooluse-task-output: Maven runner detection", () => {
  test("Maven complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(MAVEN_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("Maven truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(MAVEN_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("Maven exit 0 does not block", async () => {
    const output = "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── Gradle runner detection ──────────────────────────────────────────────────

const GRADLE_COMPLETE_OUTPUT = `
AuthTest > testLogin FAILED
    org.opentest4j.AssertionFailedError at AuthTest.java:42

AuthTest > testToken FAILED
    org.opentest4j.AssertionFailedError at AuthTest.java:67

7 tests completed, 2 failed

BUILD FAILED in 1s
`.trim()

const GRADLE_TRUNCATED_OUTPUT = `
AuthTest > testLogin FAILED
    org.opentest4j.AssertionFailedError at AuthTest.java:42
`.trim()

describe("posttooluse-task-output: Gradle runner detection", () => {
  test("Gradle complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(GRADLE_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("Gradle truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(GRADLE_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("Gradle exit 0 does not block", async () => {
    const output = "5 tests completed\n\nBUILD SUCCESSFUL in 1s"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── RSpec runner detection ───────────────────────────────────────────────────

const RSPEC_COMPLETE_OUTPUT = `
Failures:

  1) Auth#login returns false for invalid credentials
     Failure/Error: expect(auth.login("bad")).to be true
       expected true
       got false

  2) Auth#token raises on expiry
     Failure/Error: expect { auth.token }.not_to raise_error

Finished in 0.12345 seconds (files took 1.23 seconds to load)
7 examples, 2 failures
`.trim()

const RSPEC_TRUNCATED_OUTPUT = `
Failures:

  1) Auth#login returns false for invalid credentials
     Failure/Error: expect(auth.login("bad")).to be true
`.trim()

describe("posttooluse-task-output: RSpec runner detection", () => {
  test("RSpec complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(RSPEC_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("RSpec truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(RSPEC_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("RSpec exit 0 does not block", async () => {
    const output = "Finished in 0.05s\n5 examples, 0 failures"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
})

// ─── dotnet test runner detection ─────────────────────────────────────────────

const DOTNET_COMPLETE_OUTPUT = `
  Failed AuthTests.LoginTest.InvalidCredentials [12 ms]
  Failed AuthTests.TokenTest.ExpiredToken [8 ms]

Failed!  - Failed:     2, Passed:     5, Skipped:    0, Total:      7, Duration: 45 ms
`.trim()

const DOTNET_TRUNCATED_OUTPUT = `
  Failed AuthTests.LoginTest.InvalidCredentials [12 ms]
  Failed AuthTests.TokenTest.ExpiredToken [8 ms]
`.trim()

describe("posttooluse-task-output: dotnet test runner detection", () => {
  test("dotnet test complete output with failures reports exact count", async () => {
    const result = await runHook(makePayload(DOTNET_COMPLETE_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("2 test(s) failed")
    expect(result.reason).not.toContain("unknown")
  })

  test("dotnet test truncated output with failures reports unknown count", async () => {
    const result = await runHook(makePayload(DOTNET_TRUNCATED_OUTPUT, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("unknown number of test(s) failed")
  })

  test("dotnet test exit 0 does not block", async () => {
    const output =
      "Passed!  - Failed:     0, Passed:     5, Skipped:    0, Total:      5, Duration: 30 ms"
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
    expect(result.exitCode).toBe(0)
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

describe("posttooluse-task-output: PHPUnit runner detection", () => {
  test("PHPUnit complete run with failures reports exact count", async () => {
    const output = [
      "PHPUnit 10.5.0 by Sebastian Bergmann and contributors.",
      "",
      "..F..E.",
      "",
      "FAILURES!",
      "Tests: 7, Assertions: 10, Failures: 2, Errors: 1.",
    ].join("\n")
    const payload = {
      tool_name: "TaskOutput",
      cwd: "/project",
      session_id: "test-session",
      tool_response: { output, exit_code: 1 },
      tool_input: { task_id: "test-task" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/^2 test\(s\) failed/)
  })

  test("PHPUnit truncated output with FAILURES! reports unknown count", async () => {
    const output = ["PHPUnit 10.5.0 by Sebastian Bergmann and contributors.", "", "FAILURES!"].join(
      "\n"
    )
    const payload = {
      tool_name: "TaskOutput",
      cwd: "/project",
      session_id: "test-session",
      tool_response: { output, exit_code: 1 },
      tool_input: { task_id: "test-task" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/^unknown number of test\(s\) failed/)
  })

  test("PHPUnit all passing does not block", async () => {
    const output = [
      "PHPUnit 10.5.0 by Sebastian Bergmann and contributors.",
      "",
      ".......",
      "",
      "OK (7 tests, 14 assertions)",
    ].join("\n")
    const payload = {
      tool_name: "TaskOutput",
      cwd: "/project",
      session_id: "test-session",
      tool_response: { output, exit_code: 0 },
      tool_input: { task_id: "test-task" },
    }
    const result = await runHook(payload)
    expect(result.decision).toBeUndefined()
  })
})

describe("posttooluse-task-output: composite multi-runner output", () => {
  test("aggregates failures from bun + jest when both summaries present", async () => {
    const output = [
      "bun test v1.3.10",
      "✗ src/foo.test.ts > fails",
      "Ran 10 tests across 2 files.",
      "10 fail",
      "",
      "FAIL src/bar.test.ts",
      "  ● bar › fails",
      "Tests: 3 failed, 7 passed, 10 total",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/13 test\(s\) failed across multiple runners \(bun, jest\)/)
  })

  test("preserves concrete count with + when one runner output is truncated", async () => {
    // bun is complete (5 failures) but jest has FAIL_RE match without COMPLETE_RE (no "N total" line)
    // Jest sets failCount: null when incomplete, so it's a concrete+presence-only mix → "5+"
    const output = [
      "bun test v1.3.10",
      "✗ src/foo.test.ts > fails",
      "Ran 5 tests across 1 file.",
      "5 fail",
      "",
      "FAIL src/bar.test.ts",
      "  ● bar › fails",
      "Tests: 2 failed",
      // Jest COMPLETE_RE requires "N total" at end — absent here means truncated
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/5\+ test\(s\) failed across multiple runners/)
  })

  test("does not report failure when composite output shows no failures", async () => {
    const output = [
      "bun test v1.3.10",
      "Ran 10 tests across 2 files.",
      "Tests: 5 passed, 5 total",
    ].join("\n")
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
  })
})

describe("posttooluse-task-output: runner presence without FAIL_RE", () => {
  test("attributes failure to bun when presence detected but no fail summary", async () => {
    // Compile error — bun test starts but crashes before emitting fail count
    const output = ["bun test v1.3.10", 'error: Could not resolve "missing-module"', ""].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/unknown number of test\(s\) failed/)
    expect(result.reason).toMatch(/error:.*missing-module/i)
  })

  test("reports exact 0 when bun completes with no failures", async () => {
    // Non-zero exit can still occur from non-test errors; completed runner output
    // without fail summary should contribute an exact zero, not unknown.
    const output = ["bun test v1.3.10", "Ran 3 tests across 1 file."].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/^0 test\(s\) failed \(exit code 1\)\./)
  })

  test("does not attribute runner when presence detected and exit 0", async () => {
    // Runner present but exited successfully — no failure
    const output = ["bun test v1.3.10", "Ran 3 tests across 1 file."].join("\n")
    const result = await runHook(makePayload(output, 0))
    expect(result.decision).toBeUndefined()
  })

  test("attributes failure to cargo when compile error before tests run", async () => {
    const output = [
      "   Compiling mylib v0.1.0",
      "error[E0308]: mismatched types",
      "   running 0 tests",
    ].join("\n")
    const result = await runHook(makePayload(output, 101))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/unknown number of test\(s\) failed/)
    expect(result.reason).toMatch(/error/)
  })
})

describe("posttooluse-task-output: composite concrete + presence-only fallback", () => {
  test("preserves concrete bun count when cargo presence-only fallback fires", async () => {
    // bun has concrete failures; cargo presence detected (compile error before tests run)
    const output = [
      "bun test v1.3.10",
      "✗ src/foo.test.ts > fails",
      "Ran 5 tests across 1 file.",
      "5 fail",
      "",
      "   Compiling mylib v0.1.0",
      "error[E0308]: mismatched types",
      "   running 0 tests",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    // Should show concrete count with "+" rather than "unknown number of"
    expect(result.reason).toMatch(/5\+ test\(s\) failed across multiple runners/)
    expect(result.reason).toMatch(/bun, cargo/)
  })

  test("preserves concrete pytest count when dotnet presence-only fires", async () => {
    // pytest has concrete failures; dotnet presence detected but no fail summary
    const output = [
      "============================= test session starts ==============================",
      "FAILED tests/test_main.py::test_one",
      "=========================== 3 failed, 2 passed in 1.23s ========================",
      "",
      "Starting test execution",
      "error: Build failed",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/3\+ test\(s\) failed across multiple runners/)
    expect(result.reason).toMatch(/pytest, dotnet/)
  })

  test("uses lower-bound count when bun tally is incomplete", async () => {
    // Bun emits a fail tally but not the completion marker (truncated output),
    // while cargo is detected via presence-only fallback.
    const output = [
      "bun test v1.3.10",
      "✗ src/foo.test.ts > fails",
      "2 fail",
      "",
      "   Compiling mylib v0.1.0",
      "error[E0308]: mismatched types",
      "   running 0 tests",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    // Bun contributes a concrete lower-bound count even though it's incomplete.
    expect(result.reason).toMatch(/2\+ test\(s\) failed across multiple runners/)
    expect(result.reason).toMatch(/bun, cargo/)
  })

  test("counts distinct fail lines when all counts are null", async () => {
    // Both runners are incomplete and provide no numeric failCount.
    // Aggregation should count distinct matched failure lines (2) instead of "unknown".
    const output = [
      "FAIL src/auth/login.test.ts",
      "Tests: 2 failed",
      "",
      " FAIL  src/auth/session.test.ts > session > fails",
      " Tests  1 failed",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/2 test\(s\) failed across multiple runners/)
    expect(result.reason).toMatch(/jest, vitest/)
  })

  test("reports exact 0 for composite complete summaries with no failures", async () => {
    const output = [
      "bun test v1.3.10",
      "Ran 10 tests across 2 files.",
      "",
      "Tests: 5 passed, 5 total",
    ].join("\n")
    const result = await runHook(makePayload(output, 1))
    expect(result.decision).toBe("block")
    expect(result.reason).toMatch(/0 test\(s\) failed across multiple runners \(bun, jest\)/)
  })
})
