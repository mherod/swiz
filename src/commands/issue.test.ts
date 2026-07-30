/**
 * Tests for `swiz issue resolve` — idempotent issue resolution.
 *
 * Each test injects the issue state and records GitHub command requests so the
 * command behavior is covered without starting a process or hitting GitHub.
 */

import { describe, expect, test } from "bun:test"
import { runCommandInProcess } from "../utils/test-utils.ts"
import { issueCommand } from "./issue.ts"

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  calls: string[][]
}

async function runCli(args: string[], state: "OPEN" | "CLOSED" = "CLOSED"): Promise<RunResult> {
  const calls: string[][] = []
  const result = await runCommandInProcess(issueCommand, args.slice(1), {
    commandOptions: {
      operationDependencies: {
        getRepoSlug: async () => null,
        issueState: async () => state,
        acquireGhSlot: async () => {},
        async runGh(commandArgs) {
          calls.push(commandArgs)
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
    },
  })
  return { ...result, calls }
}

function ghCallsMatching(calls: string[][], keyword: string): string[][] {
  return calls.filter((args) => args.includes(keyword))
}

describe("swiz issue resolve", () => {
  test("closes an OPEN issue and posts the resolution comment", async () => {
    const result = await runCli(
      ["issue", "resolve", "42", "--body", "Fixed in commit abc123."],
      "OPEN"
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("resolved")
    expect(result.stdout).toContain("closed")

    // Comment was posted
    const commentCalls = ghCallsMatching(result.calls, "comment")
    expect(commentCalls.length).toBeGreaterThan(0)
    expect(commentCalls[0]).toContain("42")

    // Issue was closed
    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
    expect(closeCalls[0]).toContain("42")
  })

  test("skips close and reports already-closed when issue is CLOSED", async () => {
    const result = await runCli(
      ["issue", "resolve", "42", "--body", "Confirming resolution."],
      "CLOSED"
    )

    expect(result.exitCode).toBe(0)
    // Must report already-closed state, not falsely claim it was closed now
    expect(result.stdout).toContain("already")

    // Comment is still posted (for audit trail) even on closed issue
    const commentCalls = ghCallsMatching(result.calls, "comment")
    expect(commentCalls.length).toBeGreaterThan(0)

    // Close must NOT be called
    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls).toHaveLength(0)
  })

  test("closes OPEN issue with no comment when body is omitted", async () => {
    const result = await runCli(["issue", "resolve", "99"], "OPEN")

    expect(result.exitCode).toBe(0)

    // No comment call when no body
    const commentCalls = ghCallsMatching(result.calls, "comment")
    expect(commentCalls).toHaveLength(0)

    // Issue is still closed
    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
  })

  test("skips both comment and close when issue already CLOSED and no body", async () => {
    const result = await runCli(["issue", "resolve", "7"], "CLOSED")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const commentCalls = ghCallsMatching(result.calls, "comment")
    expect(commentCalls).toHaveLength(0)

    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls).toHaveLength(0)
  })
})

describe("swiz issue close (existing idempotency)", () => {
  test("closes an OPEN issue", async () => {
    const result = await runCli(["issue", "close", "5"], "OPEN")

    expect(result.exitCode).toBe(0)
    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls.length).toBeGreaterThan(0)
  })

  test("skips close and reports already-closed when issue is CLOSED", async () => {
    const result = await runCli(["issue", "close", "5"], "CLOSED")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const closeCalls = ghCallsMatching(result.calls, "close")
    expect(closeCalls).toHaveLength(0)
  })
})

describe("swiz issue comment (existing idempotency)", () => {
  test("skips comment on CLOSED issue", async () => {
    const result = await runCli(["issue", "comment", "3", "--body", "hello"], "CLOSED")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already")

    const commentCalls = ghCallsMatching(result.calls, "comment")
    const actualComment = commentCalls.filter((args) => args.includes("--body"))
    expect(actualComment).toHaveLength(0)
  })
})

describe("swiz issue error cases", () => {
  test("errors when subcommand is missing", async () => {
    const result = await runCli(["issue"])
    expect(result.exitCode).not.toBe(0)
  })

  test("errors when issue number is missing", async () => {
    const result = await runCli(["issue", "resolve"])
    expect(result.exitCode).not.toBe(0)
  })

  test("errors for unknown subcommand", async () => {
    const result = await runCli(["issue", "bogus", "42"])
    expect(result.exitCode).not.toBe(0)
  })
})
