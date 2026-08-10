import { describe, expect, it } from "vitest"
import {
  discoverRunId,
  evaluateCiRun,
  expandSha,
  type GhRunSummary,
  parseCiWaitArgs,
  selectCiRun,
  waitForCiCompletion,
} from "./ci-wait.ts"

// ─── expandSha ────────────────────────────────────────────────────────────

describe("expandSha", () => {
  it("returns full SHA unchanged without calling git", async () => {
    const fullSha = "a".repeat(40)
    const result = await expandSha(fullSha)
    expect(result).toBe(fullSha)
  })

  it("returns original SHA when git rev-parse fails (not a git SHA)", async () => {
    const notASha = "notarealsha"
    const result = await expandSha(notASha)
    // Falls back to original when rev-parse returns non-40-char or errors
    expect(result).toBe(notASha)
  })

  it("expands a valid short SHA to 40 characters", async () => {
    // Use HEAD which is always resolvable in the repo
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const shortSha = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (!shortSha) return // skip if not in a git repo

    const result = await expandSha(shortSha)
    expect(result).toHaveLength(40)
  })
})

// ─── parseCiWaitArgs ──────────────────────────────────────────────────────

describe("parseCiWaitArgs", () => {
  it("parses a bare commit SHA", () => {
    const result = parseCiWaitArgs(["abc123"])
    expect(result.commitSha).toBe("abc123")
    expect(result.timeout).toBe(300)
  })

  it("parses --timeout flag", () => {
    const result = parseCiWaitArgs(["abc123", "--timeout", "60"])
    expect(result.commitSha).toBe("abc123")
    expect(result.timeout).toBe(60)
  })

  it("parses -t shorthand", () => {
    const result = parseCiWaitArgs(["-t", "120", "def456"])
    expect(result.commitSha).toBe("def456")
    expect(result.timeout).toBe(120)
  })

  it("parses repository cwd", () => {
    expect(parseCiWaitArgs(["abc123", "--cwd", "/tmp/repo"])).toEqual({
      commitSha: "abc123",
      timeout: 300,
      cwd: "/tmp/repo",
    })
  })

  it("throws when no commit SHA provided", () => {
    expect(() => parseCiWaitArgs([])).toThrow("Commit SHA is required")
    expect(() => parseCiWaitArgs(["--timeout", "60"])).toThrow("Commit SHA is required")
  })

  it("throws for non-positive timeout", () => {
    expect(() => parseCiWaitArgs(["abc", "--timeout", "0"])).toThrow("positive number")
    expect(() => parseCiWaitArgs(["abc", "--timeout", "-5"])).toThrow("positive number")
  })

  it("throws for non-numeric timeout", () => {
    expect(() => parseCiWaitArgs(["abc", "--timeout", "abc"])).toThrow("positive number")
  })

  it("rejects malformed and missing option values", () => {
    expect(() => parseCiWaitArgs(["abc", "--timeout", "10seconds"])).toThrow("positive number")
    expect(() => parseCiWaitArgs(["abc", "--timeout"])).toThrow("requires a value")
    expect(() => parseCiWaitArgs(["abc", "--cwd"])).toThrow("requires a value")
  })

  it("rejects unknown options and extra positional arguments", () => {
    expect(() => parseCiWaitArgs(["abc", "--wat"])).toThrow("Unknown option")
    expect(() => parseCiWaitArgs(["abc", "def"])).toThrow("Unexpected argument")
  })
})

// ─── discoverRunId ────────────────────────────────────────────────────────

describe("discoverRunId", () => {
  it("returns the run ID on the first successful attempt", async () => {
    const findFn = async (_sha: string) => 42
    const result = await discoverRunId("abc123", { findFn, intervalMs: 0 })
    expect(result).toBe(42)
  })

  it("returns null after exhausting all attempts", async () => {
    const calls: number[] = []
    const findFn = async (_sha: string) => {
      calls.push(1)
      return null
    }
    const result = await discoverRunId("abc123", { maxAttempts: 3, findFn, intervalMs: 0 })
    expect(result).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it("returns run ID found on the third attempt", async () => {
    let attempt = 0
    const findFn = async (_sha: string) => {
      attempt++
      return attempt === 3 ? 99 : null
    }
    const result = await discoverRunId("abc123", { maxAttempts: 3, findFn, intervalMs: 0 })
    expect(result).toBe(99)
    expect(attempt).toBe(3)
  })

  it("calls onWaiting between failed attempts", async () => {
    const waitingCalls: [number, number][] = []
    let attempt = 0
    const findFn = async (_sha: string) => {
      attempt++
      return attempt === 2 ? 7 : null
    }
    await discoverRunId("abc123", {
      maxAttempts: 3,
      findFn,
      intervalMs: 0,
      onWaiting: (a, max) => waitingCalls.push([a, max]),
    })
    expect(waitingCalls).toEqual([[1, 3]])
  })

  it("does not sleep after the last failed attempt", async () => {
    const sleeps: number[] = []
    const findFn = async (_sha: string) => null
    await discoverRunId("abc123", {
      maxAttempts: 2,
      findFn,
      intervalMs: 0,
      onWaiting: (a) => sleeps.push(a),
    })
    // Only 1 sleep between attempt 1 and 2; no sleep after attempt 2
    expect(sleeps).toHaveLength(1)
  })
})

describe("selectCiRun", () => {
  const sha = "a".repeat(40)
  const run = (overrides: Partial<GhRunSummary>): GhRunSummary => ({
    databaseId: 1,
    workflowName: "CI",
    status: "queued",
    conclusion: null,
    event: "push",
    headSha: sha,
    url: "https://example.test/run/1",
    ...overrides,
  })

  it("prefers the CI workflow over a newer Dependabot run", () => {
    const selected = selectCiRun(
      [
        run({ databaseId: 10, workflowName: "Dependabot Updates", event: "schedule" }),
        run({ databaseId: 20 }),
      ],
      sha
    )
    expect(selected?.databaseId).toBe(20)
  })

  it("does not select a run for another commit", () => {
    expect(selectCiRun([run({ headSha: "b".repeat(40) })], sha)).toBeNull()
  })
})

describe("evaluateCiRun", () => {
  it("accepts skipped jobs when GitHub reports overall success", () => {
    expect(
      evaluateCiRun({
        status: "completed",
        conclusion: "success",
        jobs: [
          { name: "test", status: "completed", conclusion: "success" },
          { name: "policy", status: "completed", conclusion: "skipped" },
        ],
      })
    ).toEqual({ state: "completed", conclusion: "success" })
  })

  it("does not hide a failed job behind an inconsistent success conclusion", () => {
    expect(
      evaluateCiRun({
        status: "completed",
        conclusion: "success",
        jobs: [{ name: "test", status: "completed", conclusion: "failure" }],
      })
    ).toEqual({ state: "completed", conclusion: "failure" })
  })

  it("reports completed job progress while the run is active", () => {
    expect(
      evaluateCiRun({
        status: "in_progress",
        conclusion: null,
        jobs: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "test", status: "in_progress", conclusion: null },
        ],
      })
    ).toEqual({ state: "pending", completedJobs: 1 })
  })
})

describe("waitForCiCompletion", () => {
  it("uses the requested repository and verifies status after a watch transport failure", async () => {
    const sha = "c".repeat(40)
    const seen: string[] = []
    const logs: string[] = []
    const result = await waitForCiCompletion(sha, 1, {
      cwd: "/tmp/target-repo",
      discoveryPollMs: 0,
      statusPollMs: 0,
      log: (message) => logs.push(message),
      sleepFn: async () => {},
      findFn: async (receivedSha, cwd) => {
        seen.push(`find:${receivedSha}:${cwd}`)
        return 42
      },
      watchFn: async (runId, cwd) => {
        seen.push(`watch:${runId}:${cwd}`)
        return 1
      },
      viewFn: async (runId, cwd) => {
        seen.push(`view:${runId}:${cwd}`)
        return {
          status: "completed",
          conclusion: "success",
          jobs: [{ name: "test", status: "completed", conclusion: "success" }],
        }
      },
    })

    expect(result.conclusion).toBe("success")
    expect(result.runId).toBe(42)
    expect(seen).toEqual([
      `find:${sha}:/tmp/target-repo`,
      "watch:42:/tmp/target-repo",
      "view:42:/tmp/target-repo",
    ])
    expect(logs.some((message) => message.includes("stream ended early"))).toBe(true)
  })

  it("retries an unreadable authoritative response instead of reporting CI failure", async () => {
    const responses = [
      null,
      {
        status: "completed",
        conclusion: "success",
        jobs: [{ name: "test", status: "completed", conclusion: "success" }],
      },
    ]
    const logs: string[] = []
    const result = await waitForCiCompletion("d".repeat(40), 1, {
      discoveryPollMs: 0,
      statusPollMs: 0,
      log: (message) => logs.push(message),
      sleepFn: async () => {},
      findFn: async () => 77,
      watchFn: async () => 1,
      viewFn: async () => responses.shift() ?? null,
    })

    expect(result.conclusion).toBe("success")
    expect(logs.some((message) => message.includes("Could not read CI status"))).toBe(true)
  })
})
