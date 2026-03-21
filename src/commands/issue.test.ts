/**
 * Tests for `swiz issue resolve` — idempotent issue resolution.
 *
 * Each test injects a fake `gh` script at the front of PATH that returns
 * predefined output for `gh issue view` and records calls to `gh issue close`
 * and `gh issue comment` so we can assert what happened without hitting GitHub.
 */

import { describe, expect, test } from "bun:test"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../../hooks/utils/test-utils.ts"

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

const { create: createTempDir } = useTempDir("swiz-issue-")

/**
 * Write a fake `gh` binary to `binDir` that:
 *   - Returns `issueStateJson` for `gh issue view ... --json state ...`
 *   - Appends a log line to `logFile` for any other `gh issue` command
 */
async function writeFakeGh(
  binDir: string,
  logFile: string,
  issueState: "OPEN" | "CLOSED"
): Promise<void> {
  const script = [
    "#!/usr/bin/env bash",
    // Log the full invocation for assertion
    `echo "$@" >> "${logFile}"`,
    // Respond to `gh issue view <n> --json state --jq .state`
    'if [[ "$1" == "issue" && "$2" == "view" && "$*" == *"--json state"* ]]; then',
    `  echo "${issueState}"`,
    "  exit 0",
    "fi",
    // All other gh commands succeed silently
    "exit 0",
  ].join("\n")

  const ghPath = join(binDir, "gh")
  await writeFile(ghPath, script)
  await chmod(ghPath, 0o755)
}

async function runCli(args: string[], binDir: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", "index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { exitCode: proc.exitCode, stdout, stderr }
}

/** Read the gh call log and return lines with the given keyword. */
async function ghCallsMatching(logFile: string, keyword: string): Promise<string[]> {
  try {
    const content = await Bun.file(logFile).text()
    return content
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => l.includes(keyword))
  } catch {
    return []
  }
}

describe("swiz issue resolve", () => {
  test("closes an OPEN issue and posts the resolution comment", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "OPEN")

    const result = await runCli(
      ["issue", "resolve", "42", "--body", "Fixed in commit abc123."],
      dir
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("resolved")
    expect(result.stdout).toContain("closed")

    // Comment was posted
    const commentCalls = await ghCallsMatching(logFile, "comment")
    expect(commentCalls.length).toBeGreaterThan(0)
    expect(commentCalls[0]).toContain("42")

    // Issue was closed
    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
    expect(closeCalls[0]).toContain("42")
  })

  test("skips close and reports already-closed when issue is CLOSED", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "CLOSED")

    const result = await runCli(["issue", "resolve", "42", "--body", "Confirming resolution."], dir)

    expect(result.exitCode).toBe(0)
    // Must report already-closed state, not falsely claim it was closed now
    expect(result.stdout).toContain("already")

    // Comment is still posted (for audit trail) even on closed issue
    const commentCalls = await ghCallsMatching(logFile, "comment")
    expect(commentCalls.length).toBeGreaterThan(0)

    // Close must NOT be called
    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls).toHaveLength(0)
  })

  test("closes OPEN issue with no comment when body is omitted", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "OPEN")

    const result = await runCli(["issue", "resolve", "99"], dir)

    expect(result.exitCode).toBe(0)

    // No comment call when no body
    const commentCalls = await ghCallsMatching(logFile, "comment")
    expect(commentCalls).toHaveLength(0)

    // Issue is still closed
    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
  })

  test("skips both comment and close when issue already CLOSED and no body", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "CLOSED")

    const result = await runCli(["issue", "resolve", "7"], dir)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const commentCalls = await ghCallsMatching(logFile, "comment")
    expect(commentCalls).toHaveLength(0)

    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls).toHaveLength(0)
  })
})

describe("swiz issue close (existing idempotency)", () => {
  test("closes an OPEN issue", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "OPEN")

    const result = await runCli(["issue", "close", "5"], dir)

    expect(result.exitCode).toBe(0)
    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
  })

  test("skips close and reports already-closed when issue is CLOSED", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "CLOSED")

    const result = await runCli(["issue", "close", "5"], dir)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const closeCalls = await ghCallsMatching(logFile, "close")
    expect(closeCalls).toHaveLength(0)
  })
})

describe("swiz issue comment (existing idempotency)", () => {
  test("skips comment on CLOSED issue", async () => {
    const dir = await createTempDir()
    const logFile = join(dir, "gh-calls.log")
    await writeFakeGh(dir, logFile, "CLOSED")

    const result = await runCli(["issue", "comment", "3", "--body", "hello"], dir)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const commentCalls = await ghCallsMatching(logFile, "comment")
    // The "view" call and setup call appear in the log; actual "comment <n> --body" must not
    const actualComment = commentCalls.filter((l) => l.includes("--body"))
    expect(actualComment).toHaveLength(0)
  })
})

describe("swiz issue error cases", () => {
  test("errors when subcommand is missing", async () => {
    const dir = await createTempDir()
    const result = await runCli(["issue"], dir)
    expect(result.exitCode).not.toBe(0)
  })

  test("errors when issue number is missing", async () => {
    const dir = await createTempDir()
    const result = await runCli(["issue", "resolve"], dir)
    expect(result.exitCode).not.toBe(0)
  })

  test("errors for unknown subcommand", async () => {
    const dir = await createTempDir()
    const result = await runCli(["issue", "bogus", "42"], dir)
    expect(result.exitCode).not.toBe(0)
  })
})
