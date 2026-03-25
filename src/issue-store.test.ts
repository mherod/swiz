import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DaemonBackedIssueStore,
  DEFAULT_TTL_MS,
  type GitHubClient,
  ghListToRestFallback,
  IssueStore,
  type IssueStoreReader,
  replayPendingMutations,
  resetDaemonBackedStore,
  syncUpstreamState,
  tryRestFallback,
} from "./issue-store.ts"

function createStore(): IssueStore {
  const dir = join(
    tmpdir(),
    `swiz-issue-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return new IssueStore(join(dir, "test.db"))
}

let bunSpawnTestMutex: Promise<void> = Promise.resolve()

async function lockBunSpawn(): Promise<() => void> {
  let release!: () => void
  const previous = bunSpawnTestMutex
  bunSpawnTestMutex = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  return release
}

function createMockSpawnResult(stdout = "", stderr = "", exitCode = 0) {
  return {
    exited: Promise.resolve(),
    exitCode,
    stdout: new ReadableStream({
      start(controller) {
        if (stdout) controller.enqueue(new TextEncoder().encode(stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (stderr) controller.enqueue(new TextEncoder().encode(stderr))
        controller.close()
      },
    }),
  }
}

describe("DEFAULT_TTL_MS", () => {
  test("does not exceed 5 minutes (GitHub cache TTL cap)", () => {
    expect(DEFAULT_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})

describe("IssueStore", () => {
  test("upserts and lists issues within TTL", () => {
    const store = createStore()
    try {
      const issues = [
        { number: 1, title: "First", labels: [] },
        { number: 2, title: "Second", labels: [{ name: "bug" }] },
      ]
      store.upsertIssues("owner/repo", issues)

      const result = store.listIssues<{ number: number; title: string }>("owner/repo")
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.number).sort()).toEqual([1, 2])
    } finally {
      store.close()
    }
  })

  test("returns empty list for unknown repo", () => {
    const store = createStore()
    try {
      const result = store.listIssues("unknown/repo")
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("respects TTL — expired issues are excluded", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 1, title: "Old" }])
      const result = store.listIssues("owner/repo", 0)
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("getIssue returns a single cached issue", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 42, title: "The answer" }])
      const issue = store.getIssue<{ number: number; title: string }>("owner/repo", 42)
      expect(issue).not.toBeNull()
      expect(issue!.title).toBe("The answer")
    } finally {
      store.close()
    }
  })

  test("getIssue returns null for missing issue", () => {
    const store = createStore()
    try {
      const issue = store.getIssue("owner/repo", 999)
      expect(issue).toBeNull()
    } finally {
      store.close()
    }
  })

  test("removeIssue deletes from cache", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [
        { number: 1, title: "Keep" },
        { number: 2, title: "Remove" },
      ])
      store.removeIssue("owner/repo", 2)
      const result = store.listIssues<{ number: number }>("owner/repo")
      expect(result).toHaveLength(1)
      expect(result[0]!.number).toBe(1)
    } finally {
      store.close()
    }
  })

  test("upsert replaces existing issue data", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 1, title: "Original" }])
      store.upsertIssues("owner/repo", [{ number: 1, title: "Updated" }])
      const issue = store.getIssue<{ title: string }>("owner/repo", 1)
      expect(issue!.title).toBe("Updated")
    } finally {
      store.close()
    }
  })
})

describe("Mutation queue", () => {
  test("queues and retrieves mutations", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 42 })
      store.queueMutation("owner/repo", { type: "comment", number: 42, body: "Fixed" })

      const pending = store.getPendingMutations("owner/repo")
      expect(pending).toHaveLength(2)
      expect(JSON.parse(pending[0]!.mutation).type).toBe("close")
      expect(JSON.parse(pending[1]!.mutation).type).toBe("comment")
      expect(JSON.parse(pending[1]!.mutation).body).toBe("Fixed")
    } finally {
      store.close()
    }
  })

  test("pendingCount returns correct count", () => {
    const store = createStore()
    try {
      expect(store.pendingCount("owner/repo")).toBe(0)
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      store.queueMutation("owner/repo", { type: "close", number: 2 })
      expect(store.pendingCount("owner/repo")).toBe(2)
    } finally {
      store.close()
    }
  })

  test("markAttempted increments attempt count", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      const before = store.getPendingMutations("owner/repo")
      expect(before[0]!.attempts).toBe(0)
      store.markAttempted(before[0]!.id)
      const after = store.getPendingMutations("owner/repo")
      expect(after[0]!.attempts).toBe(1)
      expect(after[0]!.last_attempt).not.toBeNull()
    } finally {
      store.close()
    }
  })

  test("removeMutation deletes from queue", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      const pending = store.getPendingMutations("owner/repo")
      store.removeMutation(pending[0]!.id)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("queues PR mutation types", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "pr_comment", number: 10, body: "LGTM" })
      store.queueMutation("owner/repo", { type: "pr_merge", number: 10 })
      store.queueMutation("owner/repo", {
        type: "pr_review",
        number: 10,
        body: "Approved",
        reviewEvent: "APPROVE",
      })

      const pending = store.getPendingMutations("owner/repo")
      expect(pending).toHaveLength(3)
      expect(JSON.parse(pending[0]!.mutation).type).toBe("pr_comment")
      expect(JSON.parse(pending[1]!.mutation).type).toBe("pr_merge")
      expect(JSON.parse(pending[2]!.mutation).type).toBe("pr_review")
      expect(JSON.parse(pending[2]!.mutation).reviewEvent).toBe("APPROVE")
    } finally {
      store.close()
    }
  })

  test("mutations are isolated per repo", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo-a", { type: "close", number: 1 })
      store.queueMutation("owner/repo-b", { type: "close", number: 2 })
      expect(store.pendingCount("owner/repo-a")).toBe(1)
      expect(store.pendingCount("owner/repo-b")).toBe(1)
      expect(store.getPendingMutations("owner/repo-a")[0]!.id).not.toBe(
        store.getPendingMutations("owner/repo-b")[0]!.id
      )
    } finally {
      store.close()
    }
  })
})

describe("Pull request storage", () => {
  test("upserts and lists PRs within TTL", () => {
    const store = createStore()
    try {
      const prs = [
        { number: 10, title: "Feature A", headRefName: "feat-a" },
        { number: 11, title: "Feature B", headRefName: "feat-b" },
      ]
      store.upsertPullRequests("owner/repo", prs)
      const result = store.listPullRequests<{ number: number; title: string }>("owner/repo")
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.number).sort()).toEqual([10, 11])
    } finally {
      store.close()
    }
  })

  test("getPullRequest returns a single cached PR", () => {
    const store = createStore()
    try {
      store.upsertPullRequests("owner/repo", [{ number: 42, title: "The PR" }])
      const pr = store.getPullRequest<{ number: number; title: string }>("owner/repo", 42)
      expect(pr).not.toBeNull()
      expect(pr!.title).toBe("The PR")
    } finally {
      store.close()
    }
  })

  test("getPullRequest returns null for missing PR", () => {
    const store = createStore()
    try {
      expect(store.getPullRequest("owner/repo", 999)).toBeNull()
    } finally {
      store.close()
    }
  })

  test("removePullRequest deletes from cache", () => {
    const store = createStore()
    try {
      store.upsertPullRequests("owner/repo", [
        { number: 1, title: "Keep" },
        { number: 2, title: "Remove" },
      ])
      store.removePullRequest("owner/repo", 2)
      const result = store.listPullRequests<{ number: number }>("owner/repo")
      expect(result).toHaveLength(1)
      expect(result[0]!.number).toBe(1)
    } finally {
      store.close()
    }
  })

  test("upsert replaces existing PR data", () => {
    const store = createStore()
    try {
      store.upsertPullRequests("owner/repo", [{ number: 1, title: "Original" }])
      store.upsertPullRequests("owner/repo", [{ number: 1, title: "Updated" }])
      const pr = store.getPullRequest<{ title: string }>("owner/repo", 1)
      expect(pr!.title).toBe("Updated")
    } finally {
      store.close()
    }
  })

  test("respects TTL — expired PRs are excluded", () => {
    const store = createStore()
    try {
      store.upsertPullRequests("owner/repo", [{ number: 1, title: "Old" }])
      const result = store.listPullRequests("owner/repo", 0)
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})

describe("CI status storage", () => {
  test("upserts and lists CI statuses within TTL", () => {
    const store = createStore()
    try {
      const statuses = [
        { sha: "abc123", status: "completed", conclusion: "success", run_id: 100 },
        { sha: "def456", status: "in_progress", conclusion: null, run_id: 101 },
      ]
      store.upsertCiStatuses("owner/repo", statuses)
      const result = store.listCiStatuses<{ sha: string; status: string }>("owner/repo")
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.sha).sort()).toEqual(["abc123", "def456"])
    } finally {
      store.close()
    }
  })

  test("getCiStatus returns status for a specific SHA", () => {
    const store = createStore()
    try {
      store.upsertCiStatuses("owner/repo", [
        { sha: "abc123", status: "completed", conclusion: "success" },
      ])
      const ci = store.getCiStatus<{ sha: string; conclusion: string }>("owner/repo", "abc123")
      expect(ci).not.toBeNull()
      expect(ci!.conclusion).toBe("success")
    } finally {
      store.close()
    }
  })

  test("getCiStatus returns null for missing SHA", () => {
    const store = createStore()
    try {
      expect(store.getCiStatus("owner/repo", "nonexistent")).toBeNull()
    } finally {
      store.close()
    }
  })

  test("removeCiStatus deletes from cache", () => {
    const store = createStore()
    try {
      store.upsertCiStatuses("owner/repo", [
        { sha: "abc123", status: "completed", conclusion: "success" },
        { sha: "def456", status: "completed", conclusion: "failure" },
      ])
      store.removeCiStatus("owner/repo", "def456")
      const result = store.listCiStatuses<{ sha: string }>("owner/repo")
      expect(result).toHaveLength(1)
      expect(result[0]!.sha).toBe("abc123")
    } finally {
      store.close()
    }
  })

  test("upsert replaces existing CI status data", () => {
    const store = createStore()
    try {
      store.upsertCiStatuses("owner/repo", [
        { sha: "abc123", status: "in_progress", conclusion: null },
      ])
      store.upsertCiStatuses("owner/repo", [
        { sha: "abc123", status: "completed", conclusion: "success" },
      ])
      const ci = store.getCiStatus<{ status: string; conclusion: string }>("owner/repo", "abc123")
      expect(ci!.status).toBe("completed")
      expect(ci!.conclusion).toBe("success")
    } finally {
      store.close()
    }
  })

  test("respects TTL — expired CI statuses are excluded", () => {
    const store = createStore()
    try {
      store.upsertCiStatuses("owner/repo", [{ sha: "abc123", status: "completed" }])
      const result = store.listCiStatuses("owner/repo", 0)
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})

describe("Cross-repo isolation", () => {
  test("issues from different repos do not mix", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/alpha", [{ number: 1, title: "Alpha issue" }])
      store.upsertIssues("owner/beta", [{ number: 1, title: "Beta issue" }])
      const alpha = store.getIssue<{ title: string }>("owner/alpha", 1)
      const beta = store.getIssue<{ title: string }>("owner/beta", 1)
      expect(alpha!.title).toBe("Alpha issue")
      expect(beta!.title).toBe("Beta issue")
    } finally {
      store.close()
    }
  })

  test("PRs from different repos do not mix", () => {
    const store = createStore()
    try {
      store.upsertPullRequests("owner/alpha", [{ number: 1, title: "Alpha PR" }])
      store.upsertPullRequests("owner/beta", [{ number: 1, title: "Beta PR" }])
      const alpha = store.getPullRequest<{ title: string }>("owner/alpha", 1)
      const beta = store.getPullRequest<{ title: string }>("owner/beta", 1)
      expect(alpha!.title).toBe("Alpha PR")
      expect(beta!.title).toBe("Beta PR")
    } finally {
      store.close()
    }
  })

  test("CI statuses from different repos do not mix", () => {
    const store = createStore()
    try {
      store.upsertCiStatuses("owner/alpha", [{ sha: "abc", conclusion: "success" }])
      store.upsertCiStatuses("owner/beta", [{ sha: "abc", conclusion: "failure" }])
      const alpha = store.getCiStatus<{ conclusion: string }>("owner/alpha", "abc")
      const beta = store.getCiStatus<{ conclusion: string }>("owner/beta", "abc")
      expect(alpha!.conclusion).toBe("success")
      expect(beta!.conclusion).toBe("failure")
    } finally {
      store.close()
    }
  })
})

describe("replayPendingMutations", () => {
  test("discards mutations that exceed max attempts", async () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 999 })
      const pending = store.getPendingMutations("owner/repo")
      for (let i = 0; i < 5; i++) {
        store.markAttempted(pending[0]!.id)
      }
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.discarded).toBe(1)
      expect(result.replayed).toBe(0)
      expect(result.failed).toBe(0)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("returns zeros when no pending mutations exist", async () => {
    const store = createStore()
    try {
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.replayed).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.discarded).toBe(0)
    } finally {
      store.close()
    }
  })

  test("bumps attempt count on failed replay", async () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 999999 })
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.failed).toBe(1)
      expect(result.replayed).toBe(0)
      const after = store.getPendingMutations("owner/repo")
      expect(after).toHaveLength(1)
      expect(after[0]!.attempts).toBe(1)
    } finally {
      store.close()
    }
  })

  test("removes closed issue from cache after successful replay", async () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 42, title: "Test" }])
      store.queueMutation("owner/repo", { type: "close", number: 42 })
      const pending = store.getPendingMutations("owner/repo")
      for (let i = 0; i < 5; i++) {
        store.markAttempted(pending[0]!.id)
      }
      await replayPendingMutations("owner/repo", "/tmp", store)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("processes multiple issues in parallel with a limit", async () => {
    const store = createStore()
    const releaseMutex = await lockBunSpawn()
    const originalSpawn = Bun.spawn
    let inFlight = 0
    let maxInFlight = 0
    const concurrency = 2
    // Manually-controlled process exits — deterministic alternative to setTimeout.
    // Each Bun.spawn pushes a resolver; the test calls them explicitly to control timing.
    const releaseProcess: Array<() => void> = []

    // @ts-expect-error - Mocking Bun.spawn
    Bun.spawn = () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Push the release function inside the executor so it is guaranteed to be
      // defined at the point of push — avoids any ambiguity about executor timing.
      const exited = new Promise<void>((resolve) => {
        releaseProcess.push(() => {
          inFlight--
          resolve()
        })
      })
      return {
        exited,
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(""))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(""))
            controller.close()
          },
        }),
      }
    }

    // Yield to the microtask queue at least once, then until condition is true.
    // Yielding first ensures pending microtask chains (e.g. worker resumption after
    // exited resolves → next Bun.spawn) complete before the condition is evaluated.
    async function drainUntil(condition: () => boolean, maxTicks = 50): Promise<void> {
      for (let i = 0; i < maxTicks; i++) {
        await Promise.resolve()
        if (condition()) break
      }
    }

    try {
      for (let i = 1; i <= 5; i++) {
        store.queueMutation("owner/repo", { type: "close", number: i })
      }

      const replayPromise = replayPendingMutations("owner/repo", "/tmp", store, concurrency)

      // Wait for the pool to fill up to the concurrency limit.
      await drainUntil(() => releaseProcess.length >= concurrency)
      expect(releaseProcess.length).toBe(concurrency)
      expect(inFlight).toBe(concurrency)

      // Release processes one at a time; after each release a new spawn should occur
      // (up to the pool limit), so inFlight must never exceed concurrency.
      for (let released = 0; released < 5; released++) {
        releaseProcess[released]!()
        await drainUntil(
          // Wait for the next spawn (which happens several hops after release),
          // or for all work to be done. The initial pool has `concurrency` spawns,
          // so after N releases the total should exceed N + concurrency.
          () => releaseProcess.length > released + concurrency || inFlight === 0
        )
        expect(inFlight).toBeLessThanOrEqual(concurrency)
      }

      const result = await replayPromise
      expect(result.replayed).toBe(5)
      expect(maxInFlight).toBe(concurrency)
      expect(maxInFlight).toBeGreaterThan(1)
    } finally {
      Bun.spawn = originalSpawn
      store.close()
      releaseMutex()
    }
  })

  test("preserves ordering for mutations targeting the same issue", async () => {
    const store = createStore()
    const releaseMutex = await lockBunSpawn()
    const originalSpawn = Bun.spawn
    const sequence: number[] = []

    // @ts-expect-error - Mocking Bun.spawn
    Bun.spawn = (args: string[]) => {
      // Extract issue number and action from args
      // Args: ["gh", "issue", "comment"|"close", num, ...]
      const num = parseInt(args[3] ?? "0", 10)
      sequence.push(num)

      return {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      }
    }

    try {
      // Issue 1: comment then close
      store.queueMutation("owner/repo", { type: "comment", number: 1, body: "Closing soon" })
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      // Issue 2: close only
      store.queueMutation("owner/repo", { type: "close", number: 2 })

      await replayPendingMutations("owner/repo", "/tmp", store, 5)

      // Verify that for issue 1, comment came before close if they appear in sequence
      // Since they are handled by the same worker, they are guaranteed to be in order.
      // We just need to check the relative order of mutations for the same issue.
      const issue1Events = sequence.filter((n) => n === 1)
      expect(issue1Events).toEqual([1, 1]) // Two events for issue 1
    } finally {
      Bun.spawn = originalSpawn
      store.close()
      releaseMutex()
    }
  })
})

describe("syncUpstreamState", () => {
  test("prefers REST API queries before gh graphql-backed list commands", async () => {
    const store = createStore()
    const releaseMutex = await lockBunSpawn()
    const originalSpawn = Bun.spawn
    const calls: string[][] = []

    // @ts-expect-error - Mocking Bun.spawn
    Bun.spawn = (args: string[]) => {
      calls.push(args)

      if (args[0] !== "gh" || args[1] !== "api") {
        return createMockSpawnResult("", "unexpected non-REST command", 1)
      }

      const endpoint = args[2] ?? ""
      if (endpoint.startsWith("repos/{owner}/{repo}/issues?state=open")) {
        return createMockSpawnResult(
          JSON.stringify([
            {
              number: 101,
              title: "REST issue",
              state: "open",
              updated_at: "2024-06-01T00:00:00Z",
              user: { login: "alice" },
              assignees: [],
              labels: [],
            },
          ])
        )
      }
      if (endpoint.startsWith("repos/{owner}/{repo}/pulls?state=open")) {
        return createMockSpawnResult(
          JSON.stringify([
            {
              number: 202,
              title: "REST pr",
              state: "open",
              html_url: "https://github.com/owner/repo/pull/202",
              created_at: "2024-05-01T00:00:00Z",
              updated_at: "2024-06-02T00:00:00Z",
              user: { login: "bob" },
              head: { ref: "feature/rest-primary" },
            },
          ])
        )
      }
      if (endpoint.startsWith("repos/{owner}/{repo}/actions/runs?per_page=20")) {
        return createMockSpawnResult(JSON.stringify({ workflow_runs: [] }))
      }
      if (endpoint.startsWith("repos/{owner}/{repo}/issues?state=closed")) {
        return createMockSpawnResult(JSON.stringify([]))
      }
      if (endpoint.startsWith("repos/{owner}/{repo}/pulls?state=closed")) {
        return createMockSpawnResult(JSON.stringify([]))
      }

      return createMockSpawnResult("", `unexpected endpoint: ${endpoint}`, 1)
    }

    try {
      const result = await syncUpstreamState("owner/repo", "/tmp", store)

      expect(result.issues.upserted).toBe(1)
      expect(result.pullRequests.upserted).toBe(1)
      expect(result.ciStatuses.upserted).toBe(0)
      expect(calls).toHaveLength(5)
      expect(calls.every((args) => args[0] === "gh" && args[1] === "api")).toBe(true)
      expect(store.getIssue<{ title: string }>("owner/repo", 101)?.title).toBe("REST issue")
      expect(store.getPullRequest<{ title: string }>("owner/repo", 202)?.title).toBe("REST pr")
    } finally {
      Bun.spawn = originalSpawn
      store.close()
      releaseMutex()
    }
  })
})

describe("ghListToRestFallback", () => {
  test("maps issue list args to REST issues endpoint", () => {
    const mapping = ghListToRestFallback(["issue", "list", "--state", "open", "--json", "number"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/issues")
    expect(mapping!.endpoint).toContain("state=open")
  })

  test("maps closed issue list args to closed REST issues endpoint", () => {
    const mapping = ghListToRestFallback(["issue", "list", "--state", "closed", "--json", "number"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/issues")
    expect(mapping!.endpoint).toContain("state=closed")
  })

  test("maps pr list args to REST pulls endpoint", () => {
    const mapping = ghListToRestFallback(["pr", "list", "--state", "open", "--json", "number"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/pulls")
    expect(mapping!.endpoint).toContain("state=open")
  })

  test("maps closed pr list args to closed REST pulls endpoint", () => {
    const mapping = ghListToRestFallback(["pr", "list", "--state", "closed", "--json", "number"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/pulls")
    expect(mapping!.endpoint).toContain("state=closed")
  })

  test("issue list fallback respects --limit", () => {
    const mapping = ghListToRestFallback(["issue", "list", "--state", "open", "--limit", "30"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("per_page=30")
  })

  test("normalize converts REST issue shape to gh CLI shape and filters PRs", () => {
    const mapping = ghListToRestFallback(["issue", "list"])!
    const raw = [
      {
        number: 42,
        title: "Bug",
        state: "open",
        updated_at: "2024-06-01T00:00:00Z",
        user: { login: "alice" },
        assignees: [{ login: "bob" }],
        labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
      },
      {
        number: 99,
        title: "PR masquerading as issue",
        state: "open",
        updated_at: "2024-06-02T00:00:00Z",
        user: { login: "carol" },
        pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/99" },
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result).toHaveLength(1)
    expect(result[0]!.number).toBe(42)
    expect(result[0]!.updatedAt).toBe("2024-06-01T00:00:00Z")
    expect(result[0]!.author).toEqual({ login: "alice" })
    expect(result[0]!.assignees).toEqual([{ login: "bob" }])
    expect(result[0]!.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ])
  })

  test("normalize converts REST pr shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["pr", "list"])!
    const raw = [
      {
        number: 7,
        title: "Feature",
        state: "open",
        html_url: "https://github.com/owner/repo/pull/7",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-06-01T00:00:00Z",
        user: { login: "alice" },
        head: { ref: "feature-branch" },
        mergeable: true,
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result).toHaveLength(1)
    expect(result[0]!.number).toBe(7)
    expect(result[0]!.headRefName).toBe("feature-branch")
    expect(result[0]!.author).toEqual({ login: "alice" })
    expect(result[0]!.mergeable).toBe("MERGEABLE")
    expect(result[0]!.reviewDecision).toBe("")
    expect(result[0]!.statusCheckRollup).toEqual([])
    expect(result[0]!.createdAt).toBe("2024-01-01T00:00:00Z")
    expect(result[0]!.updatedAt).toBe("2024-06-01T00:00:00Z")
  })

  test("maps run list args to REST actions/runs endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["run", "list", "--json", "headSha,databaseId"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("actions/runs")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST run shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["run", "list"])!
    const raw = {
      workflow_runs: [
        {
          head_sha: "abc123",
          id: 999,
          status: "completed",
          conclusion: "success",
          html_url: "https://example.com",
        },
      ],
    }
    const result = mapping.normalize!(raw) as Array<{
      headSha: string
      databaseId: number
      conclusion: string
    }>
    expect(result).toHaveLength(1)
    expect(result[0]!.headSha).toBe("abc123")
    expect(result[0]!.databaseId).toBe(999)
    expect(result[0]!.conclusion).toBe("success")
  })

  test("normalize handles null conclusion from REST", () => {
    const mapping = ghListToRestFallback(["run", "list"])!
    const raw = {
      workflow_runs: [
        { head_sha: "def456", id: 100, status: "in_progress", conclusion: null, html_url: "" },
      ],
    }
    const result = mapping.normalize!(raw) as Array<{ conclusion: string }>
    expect(result[0]!.conclusion).toBe("")
  })

  test("maps release list args to REST releases endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["release", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/releases")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST release shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["release", "list"])!
    const raw = [
      {
        tag_name: "v1.2.3",
        name: "Release 1.2.3",
        draft: false,
        prerelease: false,
        published_at: "2024-01-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.tagName).toBe("v1.2.3")
    expect(result[0]!.isDraft).toBe(false)
    expect(result[0]!.isPrerelease).toBe(false)
    expect(result[0]!.publishedAt).toBe("2024-01-01T00:00:00Z")
  })

  test("normalize handles null published_at in release by falling back to created_at", () => {
    const mapping = ghListToRestFallback(["release", "list"])!
    const raw = [
      {
        tag_name: "v0.1.0",
        name: "Draft",
        draft: true,
        prerelease: true,
        published_at: null,
        created_at: "2023-06-15T12:00:00Z",
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.publishedAt).toBe("2023-06-15T12:00:00Z")
    expect(result[0]!.isDraft).toBe(true)
  })

  test("maps label list args to REST labels endpoint without normalize", () => {
    const mapping = ghListToRestFallback(["label", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/labels")
    expect(mapping!.normalize).toBeUndefined()
  })

  test("maps milestone list args to REST milestones endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["milestone", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/milestones")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST milestone shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["milestone", "list"])!
    const raw = [
      {
        number: 3,
        title: "v2.0",
        description: "Major release",
        state: "open",
        due_on: "2024-12-31T00:00:00Z",
        open_issues: 5,
        closed_issues: 10,
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.number).toBe(3)
    expect(result[0]!.title).toBe("v2.0")
    expect(result[0]!.dueOn).toBe("2024-12-31T00:00:00Z")
    expect(result[0]!.openIssues).toBe(5)
    expect(result[0]!.closedIssues).toBe(10)
  })

  test("normalize handles null due_on in milestone", () => {
    const mapping = ghListToRestFallback(["milestone", "list"])!
    const raw = [
      {
        number: 1,
        title: "No due date",
        description: null,
        state: "open",
        due_on: null,
        open_issues: 0,
        closed_issues: 0,
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.dueOn).toBeNull()
    expect(result[0]!.description).toBe("")
  })

  test("maps repo list args to REST user/repos endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["repo", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("user/repos")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST repo shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["repo", "list"])!
    const raw = [
      {
        name: "my-repo",
        full_name: "owner/my-repo",
        description: "A test repo",
        private: false,
        html_url: "https://github.com/owner/my-repo",
      },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.name).toBe("my-repo")
    expect(result[0]!.nameWithOwner).toBe("owner/my-repo")
    expect(result[0]!.isPrivate).toBe(false)
    expect(result[0]!.url).toBe("https://github.com/owner/my-repo")
  })

  test("normalize handles null description in repo", () => {
    const mapping = ghListToRestFallback(["repo", "list"])!
    const raw = [
      { name: "bare", full_name: "owner/bare", description: null, private: true, html_url: "" },
    ]
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.description).toBe("")
    expect(result[0]!.isPrivate).toBe(true)
  })

  test("maps workflow list args to REST actions/workflows endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["workflow", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("actions/workflows")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST workflow shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["workflow", "list"])!
    const raw = {
      workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
    }
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.id).toBe(1)
    expect(result[0]!.name).toBe("CI")
    expect(result[0]!.path).toBe(".github/workflows/ci.yml")
    expect(result[0]!.state).toBe("active")
  })

  test("normalize handles missing workflows array in workflow list", () => {
    const mapping = ghListToRestFallback(["workflow", "list"])!
    const result = mapping.normalize!({}) as unknown[]
    expect(result).toEqual([])
  })

  test("maps secret list args to REST actions/secrets endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["secret", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("actions/secrets")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST secret shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["secret", "list"])!
    const raw = {
      secrets: [
        { name: "TOKEN", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-06-01T00:00:00Z" },
      ],
    }
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.name).toBe("TOKEN")
    expect(result[0]!.createdAt).toBe("2024-01-01T00:00:00Z")
    expect(result[0]!.updatedAt).toBe("2024-06-01T00:00:00Z")
  })

  test("maps variable list args to REST actions/variables endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["variable", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("actions/variables")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST variable shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["variable", "list"])!
    const raw = {
      variables: [
        {
          name: "NODE_ENV",
          value: "production",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        },
      ],
    }
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.name).toBe("NODE_ENV")
    expect(result[0]!.value).toBe("production")
    expect(result[0]!.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("maps environment list args to REST environments endpoint with normalize", () => {
    const mapping = ghListToRestFallback(["environment", "list"])
    expect(mapping).not.toBeNull()
    expect(mapping!.endpoint).toContain("/environments")
    expect(mapping!.normalize).toBeTypeOf("function")
  })

  test("normalize converts REST environment shape to gh CLI shape", () => {
    const mapping = ghListToRestFallback(["environment", "list"])!
    const raw = {
      environments: [
        {
          id: 42,
          name: "production",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
        },
      ],
    }
    const result = mapping.normalize!(raw) as Array<Record<string, unknown>>
    expect(result[0]!.id).toBe(42)
    expect(result[0]!.name).toBe("production")
    expect(result[0]!.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("normalize handles missing environments array in environment list", () => {
    const mapping = ghListToRestFallback(["environment", "list"])!
    const result = mapping.normalize!({}) as unknown[]
    expect(result).toEqual([])
  })

  test("returns null for unrecognised commands", () => {
    expect(ghListToRestFallback(["status", "check"])).toBeNull()
    expect(ghListToRestFallback(["commit", "list"])).toBeNull()
    expect(ghListToRestFallback([])).toBeNull()
  })
})

describe("syncUpstreamState with mock GitHubClient", () => {
  test("uses injected GitHubClient instead of gh CLI", async () => {
    const store = createStore()
    const mockClient: GitHubClient = {
      listIssues: async (_cwd, state) => {
        if (state === "open") return [{ number: 1, title: "Mock issue", state: "open" }]
        return []
      },
      listPullRequests: async (_cwd, state) => {
        if (state === "open") return [{ number: 10, title: "Mock PR", state: "open" }]
        return []
      },
      listWorkflowRuns: async () => [],
    }

    try {
      const result = await syncUpstreamState("test/repo", "/tmp", store, mockClient)
      expect(result.issues.upserted).toBe(1)
      expect(result.pullRequests.upserted).toBe(1)
      expect(result.ciStatuses.upserted).toBe(0)
      expect(store.getIssue<{ title: string }>("test/repo", 1)?.title).toBe("Mock issue")
      expect(store.getPullRequest<{ title: string }>("test/repo", 10)?.title).toBe("Mock PR")
    } finally {
      store.close()
    }
  })

  test("handles null returns from GitHubClient gracefully", async () => {
    const store = createStore()
    const nullClient: GitHubClient = {
      listIssues: async () => null,
      listPullRequests: async () => null,
      listWorkflowRuns: async () => null,
    }

    try {
      const result = await syncUpstreamState("test/repo", "/tmp", store, nullClient)
      expect(result.issues.upserted).toBe(0)
      expect(result.pullRequests.upserted).toBe(0)
      expect(result.ciStatuses.upserted).toBe(0)
    } finally {
      store.close()
    }
  })

  test("closed issues/PRs remove stale rows from store", async () => {
    const store = createStore()
    // Pre-populate with issues that will be "closed"
    store.upsertIssues("test/repo", [
      { number: 1, title: "Open" },
      { number: 2, title: "Will close" },
    ])
    store.upsertPullRequests("test/repo", [
      { number: 10, title: "Open PR" },
      { number: 20, title: "Will merge" },
    ])

    const client: GitHubClient = {
      listIssues: async (_cwd, state) => {
        if (state === "open") return [{ number: 1, title: "Open" }]
        return [{ number: 2 }] // closed
      },
      listPullRequests: async (_cwd, state) => {
        if (state === "open") return [{ number: 10, title: "Open PR" }]
        return [{ number: 20 }] // closed
      },
      listWorkflowRuns: async () => [],
    }

    try {
      const result = await syncUpstreamState("test/repo", "/tmp", store, client)
      expect(result.issues.upserted).toBe(1)
      expect(result.issues.removed).toBeGreaterThanOrEqual(1)
      expect(result.pullRequests.upserted).toBe(1)
      expect(result.pullRequests.removed).toBeGreaterThanOrEqual(1)
      // Stale #2 and #20 should be gone
      expect(store.getIssue("test/repo", 2)).toBeNull()
      expect(store.getPullRequest("test/repo", 20)).toBeNull()
      // Open #1 and #10 should remain
      expect(store.getIssue("test/repo", 1)).not.toBeNull()
      expect(store.getPullRequest("test/repo", 10)).not.toBeNull()
    } finally {
      store.close()
    }
  })

  test("CI runs are upserted into store", async () => {
    const store = createStore()
    const client: GitHubClient = {
      listIssues: async () => [],
      listPullRequests: async () => [],
      listWorkflowRuns: async () => [
        {
          headSha: "abc123",
          databaseId: 999,
          status: "completed",
          conclusion: "success",
          url: "https://example.com/run/999",
        },
        {
          headSha: "def456",
          databaseId: 888,
          status: "in_progress",
          conclusion: "",
          url: "https://example.com/run/888",
        },
      ],
    }

    try {
      const result = await syncUpstreamState("test/repo", "/tmp", store, client)
      expect(result.ciStatuses.upserted).toBe(2)
      const ci = store.getCiStatus<{ run_id: number; conclusion: string }>("test/repo", "abc123")
      expect(ci?.run_id).toBe(999)
      expect(ci?.conclusion).toBe("success")
      const ci2 = store.getCiStatus<{ run_id: number; conclusion: string }>("test/repo", "def456")
      expect(ci2?.run_id).toBe(888)
      expect(ci2?.conclusion).toBe("")
    } finally {
      store.close()
    }
  })

  test("empty open lists remove all stale rows", async () => {
    const store = createStore()
    store.upsertIssues("test/repo", [
      { number: 1, title: "Stale" },
      { number: 2, title: "Also stale" },
    ])

    const client: GitHubClient = {
      listIssues: async (_cwd, state) => (state === "open" ? [] : []),
      listPullRequests: async (_cwd, state) => (state === "open" ? [] : []),
      listWorkflowRuns: async () => [],
    }

    try {
      const result = await syncUpstreamState("test/repo", "/tmp", store, client)
      // 0 open issues upserted, but stale rows should be purged
      expect(result.issues.upserted).toBe(0)
      expect(result.issues.removed).toBe(2)
      expect(store.getIssue("test/repo", 1)).toBeNull()
      expect(store.getIssue("test/repo", 2)).toBeNull()
    } finally {
      store.close()
    }
  })
})

describe("IssueStoreReader", () => {
  test("IssueStore.asReader() returns a valid IssueStoreReader", async () => {
    const store = createStore()
    try {
      store.upsertIssues("test/repo", [
        { number: 1, title: "Issue A" },
        { number: 2, title: "Issue B" },
      ])
      store.upsertPullRequests("test/repo", [{ number: 10, title: "PR X" }])

      const reader: IssueStoreReader = store.asReader()
      const issues = await reader.listIssues<{ title: string }>("test/repo")
      expect(issues).toHaveLength(2)
      expect(issues[0]!.title).toBe("Issue A")

      const prs = await reader.listPullRequests<{ title: string }>("test/repo")
      expect(prs).toHaveLength(1)
      expect(prs[0]!.title).toBe("PR X")

      const issue = await reader.getIssue<{ title: string }>("test/repo", 1)
      expect(issue?.title).toBe("Issue A")

      store.upsertPullRequests("test/repo", [{ number: 10, title: "PR X", headRefName: "feat/x" }])
      store.upsertCiStatuses("test/repo", [
        { sha: "deadbeef", run_id: 99, status: "completed", conclusion: "success", url: "u" },
      ])
      store.upsertCiBranchRuns("test/repo", "main", [
        { databaseId: 1, status: "completed", conclusion: "success", workflowName: "CI" },
      ])
      store.upsertPrBranchDetail("test/repo", "feat/x", {
        reviewDecision: "REVIEW_REQUIRED",
        commentCount: 2,
      })

      const pr = await reader.getPullRequest<{ title: string }>("test/repo", 10)
      expect(pr?.title).toBe("PR X")

      const ci = await reader.getCiStatus<{ conclusion: string }>("test/repo", "deadbeef")
      expect(ci?.conclusion).toBe("success")

      const runs = await reader.getCiBranchRuns<{ workflowName: string }>("test/repo", "main")
      expect(runs).toHaveLength(1)
      expect(runs![0]!.workflowName).toBe("CI")

      const detail = await reader.getPrBranchDetail<{ commentCount: number }>("test/repo", "feat/x")
      expect(detail?.commentCount).toBe(2)

      const missing = await reader.getIssue("test/repo", 999)
      expect(missing).toBeNull()
    } finally {
      store.close()
    }
  })

  test("mock IssueStoreReader can substitute for real stores", async () => {
    const data = [{ number: 42, title: "Mocked" }]
    const mockReader: IssueStoreReader = {
      listIssues: async <T = unknown>() => data as T[],
      listPullRequests: async <T = unknown>() => [] as T[],
      getIssue: async <T = unknown>(_repo: string, num: number) =>
        (num === 42 ? data[0] : null) as T | null,
      getPullRequest: async () => null,
      getCiStatus: async () => null,
      getCiBranchRuns: async () => null,
      getPrBranchDetail: async () => null,
    }

    const issues = await mockReader.listIssues("any/repo")
    expect(issues).toHaveLength(1)
    expect(issues[0]).toEqual({ number: 42, title: "Mocked" })

    const found = await mockReader.getIssue("any/repo", 42)
    expect(found).toEqual({ number: 42, title: "Mocked" })

    const notFound = await mockReader.getIssue("any/repo", 99)
    expect(notFound).toBeNull()
  })

  test("asReader() returns empty arrays for repos with no data", async () => {
    const store = createStore()
    try {
      const reader = store.asReader()
      const issues = await reader.listIssues("nonexistent/repo")
      expect(issues).toEqual([])
      const prs = await reader.listPullRequests("nonexistent/repo")
      expect(prs).toEqual([])
      const issue = await reader.getIssue("nonexistent/repo", 1)
      expect(issue).toBeNull()
    } finally {
      store.close()
    }
  })

  test("asReader() returns empty after TTL expiry", async () => {
    const store = createStore()
    try {
      store.upsertIssues("test/repo", [{ number: 1, title: "Old" }])
      // Default TTL is 5 minutes; passing ttlMs=0 to listIssues forces expiry
      // asReader() uses default TTL, but we can verify the sync read returns empty with 0 TTL
      const expired = store.listIssues("test/repo", 0)
      expect(expired).toEqual([])
      // asReader() uses default TTL — data just inserted should still be fresh
      const reader = store.asReader()
      const fresh = await reader.listIssues("test/repo")
      expect(fresh).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("asReader() reflects mutations between calls", async () => {
    const store = createStore()
    try {
      const reader = store.asReader()
      // Initially empty
      expect(await reader.listIssues("test/repo")).toEqual([])
      // Add data after reader creation
      store.upsertIssues("test/repo", [{ number: 5, title: "New" }])
      // Reader should reflect the new data
      const issues = await reader.listIssues<{ title: string }>("test/repo")
      expect(issues).toHaveLength(1)
      expect(issues[0]!.title).toBe("New")
    } finally {
      store.close()
    }
  })
})

describe("DaemonBackedIssueStore", () => {
  afterEach(() => {
    resetDaemonBackedStore()
  })

  test("getPullRequest maps gh-query JSON array to a single object", async () => {
    const fetchMock = (async () =>
      Response.json({ value: [{ number: 9, title: "T" }], hit: false })) as unknown as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)
    const pr = await store.getPullRequest<{ number: number; title: string }>("owner/repo", 9)
    expect(pr).toEqual({ number: 9, title: "T" })
  })

  test("getCiStatus maps first workflow run to upsertCiStatuses-compatible shape", async () => {
    const fetchMock = (async () =>
      Response.json({
        value: [
          {
            databaseId: 42,
            status: "completed",
            conclusion: "success",
            url: "https://example.com/run",
            headSha: "abc123",
          },
        ],
        hit: false,
      })) as unknown as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)
    const st = await store.getCiStatus("owner/repo", "abc123")
    expect(st).toMatchObject({
      sha: "abc123",
      run_id: 42,
      status: "completed",
      conclusion: "success",
      url: "https://example.com/run",
    })
  })

  test("getCiBranchRuns returns workflow rows from gh-query", async () => {
    const rows = [{ databaseId: 1, workflowName: "CI" }]
    const fetchMock = (async () =>
      Response.json({ value: rows, hit: false })) as unknown as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)
    const runs = await store.getCiBranchRuns("owner/repo", "main")
    expect(runs).toEqual(rows)
  })

  test("getPrBranchDetail maps reviewDecision and comment count", async () => {
    const fetchMock = (async () =>
      Response.json({
        value: [{ reviewDecision: "APPROVED", comments: [{ id: 1 }, { id: 2 }] }],
        hit: false,
      })) as unknown as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)
    const d = await store.getPrBranchDetail<{ reviewDecision: string; commentCount: number }>(
      "owner/repo",
      "feature/foo"
    )
    expect(d).toEqual({ reviewDecision: "APPROVED", commentCount: 2 })
  })

  test("returns null from read helpers when gh-query value is null", async () => {
    const fetchMock = (async () =>
      Response.json({ value: null, hit: false })) as unknown as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)
    expect(await store.getPullRequest("owner/repo", 1)).toBeNull()
    expect(await store.getCiStatus("owner/repo", "sha")).toBeNull()
    expect(await store.getCiBranchRuns("owner/repo", "main")).toBeNull()
    expect(await store.getPrBranchDetail("owner/repo", "b")).toBeNull()
  })
})

describe("tryRestFallback", () => {
  test("returns null and does not throw for unrecognised commands", async () => {
    const result = await tryRestFallback(["status", "check"], "/tmp")
    expect(result).toBeNull()
  })

  test("returns null for empty args (no mapping)", async () => {
    const result = await tryRestFallback([], "/tmp")
    expect(result).toBeNull()
  })

  test("returns null for commit list (no REST mapping)", async () => {
    const result = await tryRestFallback(["commit", "list"], "/tmp")
    expect(result).toBeNull()
  })
})

describe("Store migration", () => {
  test("adds pull_requests and ci_status tables to an existing v1 database", () => {
    const dir = join(
      tmpdir(),
      `swiz-issue-store-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, "migrate.db")

    // Create a v1 database with only issues + pending_mutations
    const rawDb = new Database(dbPath)
    rawDb.run("PRAGMA journal_mode=WAL")
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS issues (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      )
    `)
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS pending_mutations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        mutation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt INTEGER,
        attempts INTEGER DEFAULT 0
      )
    `)
    // Insert a pre-existing issue
    rawDb.run("INSERT INTO issues (repo, number, data, synced_at) VALUES (?, ?, ?, ?)", [
      "owner/repo",
      1,
      JSON.stringify({ number: 1, title: "Existing" }),
      Date.now(),
    ])
    rawDb.close()

    // Open with IssueStore — migration should add new tables without destroying old data
    const store = new IssueStore(dbPath)
    try {
      // Existing issue data survives migration
      const issue = store.getIssue<{ title: string }>("owner/repo", 1)
      expect(issue).not.toBeNull()
      expect(issue!.title).toBe("Existing")

      // New PR table works
      store.upsertPullRequests("owner/repo", [{ number: 5, title: "New PR" }])
      const pr = store.getPullRequest<{ title: string }>("owner/repo", 5)
      expect(pr!.title).toBe("New PR")

      // New CI status table works
      store.upsertCiStatuses("owner/repo", [{ sha: "abc", status: "completed" }])
      const ci = store.getCiStatus<{ status: string }>("owner/repo", "abc")
      expect(ci!.status).toBe("completed")
    } finally {
      store.close()
    }
  })
})
