/**
 * Tests for `swiz issue resolve` — idempotent issue resolution.
 *
 * Each test injects the issue state and records GitHub command requests so the
 * command behavior is covered without starting a process or hitting GitHub.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { getIssueStore, resetIssueStore } from "../issue-store.ts"
import * as upstreamSync from "../issue-store-sync.ts"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { ensureFreshData } from "./issue/operations.ts"
import { issueCommand } from "./issue.ts"

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  calls: string[][]
  slots: number
}

async function runCli(
  args: string[],
  state: "OPEN" | "CLOSED" = "CLOSED",
  options: { repo?: string; fail?: string } = {}
): Promise<RunResult> {
  const calls: string[][] = []
  let slots = 0
  const result = await runCommandInProcess(issueCommand, args.slice(1), {
    commandOptions: {
      operationDependencies: {
        getRepoSlug: async () => options.repo ?? null,
        issueState: async () => state,
        acquireGhSlot: async () => {
          slots++
        },
        async runGh(commandArgs) {
          calls.push(commandArgs)
          if (options.fail && commandArgs.includes(options.fail)) {
            return { exitCode: 1, stdout: "", stderr: "GitHub request failed" }
          }
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
    },
  })
  return { ...result, calls, slots }
}

function ghCallsMatching(calls: string[][], keyword: string): string[][] {
  return calls.filter((args) => args.includes(keyword))
}

describe("issue operations with unavailable SQLite", () => {
  const tmp = useTempDir("swiz-issue-noop-")
  let syncRequests: string[][]

  beforeEach(async () => {
    resetIssueStore()
    // A directory cannot be opened as a SQLite file: use the real fallback.
    expect(getIssueStore(await tmp.create()).isNoOp).toBe(true)
    syncRequests = []
    spyOn(upstreamSync, "syncUpstreamState").mockImplementation(async (repo, cwd) => {
      syncRequests.push([repo, cwd])
      throw new Error("cache sync requested")
    })
  })

  afterEach(() => {
    mock.restore()
    resetIssueStore()
  })

  test("returns empty issue and pull-request snapshots", () => {
    const store = getIssueStore()
    expect(store.getIssueSnapshot("test/repo")).toEqual({ count: 0, maxUpdatedAt: null })
    expect(store.getPullRequestSnapshot("test/repo")).toEqual({ count: 0, maxUpdatedAt: null })
  })

  test.each([
    "OPEN",
    "CLOSED",
  ] as const)("resolves a %s issue without syncing the unavailable cache", async (state) => {
    const result = await runCli(["issue", "resolve", "42", "--body", "Fixed."], state, {
      repo: "test/repo",
    })
    expect(result.exitCode).toBe(0)
    expect(syncRequests).toEqual([])
    const expectedCalls = [["issue", "comment", "42", "--body", "Fixed."]]
    if (state === "OPEN") expectedCalls.push(["issue", "close", "42"])
    expect(result.calls).toEqual(expectedCalls)
    expect(result.slots).toBe(expectedCalls.length)
    expect(result.stdout).toContain(state === "OPEN" ? "Issue closed." : "already CLOSED")
  })

  test.each(["comment", "close"])("reports a remote %s failure", async (fail) => {
    const result = await runCli(["issue", "resolve", "42", "--body", "Fixed."], "OPEN", {
      repo: "test/repo",
      fail,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`gh issue ${fail} failed`)
    expect(result.stdout).not.toContain("resolved")
    expect(syncRequests).toEqual([])
    expect(ghCallsMatching(result.calls, "comment")).toHaveLength(1)
    expect(ghCallsMatching(result.calls, "close")).toHaveLength(fail === "comment" ? 0 : 1)
    expect(result.slots).toBe(result.calls.length)
  })

  test("keeps healthy empty-cache refresh and fresh-cache reuse", async () => {
    resetIssueStore()
    const store = getIssueStore(":memory:")
    expect(store.isNoOp).toBe(false)
    await expect(ensureFreshData("test/repo", process.cwd())).rejects.toThrow(
      "cache sync requested"
    )
    expect(syncRequests).toEqual([["test/repo", process.cwd()]])
    store.upsertIssues("test/repo", [{ number: 42 }])
    await expect(ensureFreshData("test/repo", process.cwd())).resolves.toBeUndefined()
    expect(syncRequests).toHaveLength(1)
  })
})

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
