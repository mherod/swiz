import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  type GitHubClient,
  type GitHubCommentRecord,
  type GitHubIssueRecord,
  IssueStore,
} from "./issue-store.ts"
import { syncUpstreamState } from "./issue-store-sync.ts"
import { useTempDir } from "./utils/test-utils.ts"

const temp = useTempDir("comment-sync-")
const stores: IssueStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function fixture(count = 2) {
  const cwd = await temp.create()
  const store = new IssueStore(join(cwd, "issues.db"))
  stores.push(store)
  const calls: number[] = []
  const issues: GitHubIssueRecord[] = Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index}`,
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [{ name: "waiting" }],
  }))
  const client: GitHubClient = {
    listIssues: async (_cwd, state) => (state === "open" ? issues : []),
    listPullRequests: async () => [],
    listWorkflowRuns: async () => [],
    listLabels: async () => [],
    listMilestones: async () => [],
    listBranchWorkflowRuns: async () => [],
    getBranchProtection: async () => null,
    listIssueEventsSince: async () => [],
    listPullRequestReviews: async () => [],
    listIssueComments: async (_cwd, number) => {
      calls.push(number)
      return [{ id: number, body: "original" }]
    },
  }
  const sync = (options: { forceComments?: boolean; signal?: AbortSignal } = {}) =>
    syncUpstreamState("test/repo", cwd, { store, client, ...options })
  return { cwd, store, calls, issues, client, sync }
}

describe("issue discussion freshness", () => {
  test("refreshes only the changed issue and skips fresh unchanged discussions", async () => {
    const f = await fixture()
    await f.sync()
    f.calls.length = 0
    await f.sync()
    expect(f.calls).toEqual([])
    f.issues[0]!.title = "changed without advancing the maximum timestamp"
    await f.sync()
    expect(f.calls).toEqual([1])
  })

  test("refreshes stale and forced threads even when primary lists are unchanged", async () => {
    const f = await fixture()
    await f.sync()
    f.calls.length = 0
    for (const issue of f.issues)
      f.store.setSyncCursor("test/repo", `issue_comments:${issue.number}`, "1")
    await f.sync()
    expect(f.calls).toEqual([1, 2])
    f.calls.length = 0
    await f.sync({ forceComments: true })
    expect(f.calls).toEqual([1, 2])
  })

  test("preserves cached comments after partial failure and retries the changed version", async () => {
    const f = await fixture()
    await f.sync()
    f.issues[0]!.updatedAt = "2026-02-01T00:00:00Z"
    f.client.listIssueComments = async () => null
    await f.sync()
    expect(f.store.listIssueComments("test/repo", 1)).toEqual([{ id: 1, body: "original" }])
    f.client.listIssueComments = async (_cwd, number) => {
      f.calls.push(number)
      return []
    }
    f.calls.length = 0
    await f.sync()
    expect(f.calls).toEqual([1])
    expect(f.store.listIssueComments("test/repo", 1)).toBeNull()
    f.calls.length = 0
    await f.sync()
    expect(f.calls).toEqual([])
  })

  test("bounds scheduling and continues after a rejected thread", async () => {
    const f = await fixture(9)
    let active = 0
    let peak = 0
    f.client.listIssueComments = async (_cwd, number) => {
      f.calls.push(number)
      peak = Math.max(peak, ++active)
      await Promise.resolve()
      active--
      if (number === 2) throw new Error("temporary failure")
      return [{ id: number, body: "edited", author: { login: "owner" } }]
    }
    await f.sync()
    expect(f.calls).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    expect(f.store.listIssueComments<GitHubCommentRecord>("test/repo", 9)?.[0]?.author?.login).toBe(
      "owner"
    )
    f.calls.length = 0
    await f.sync()
    expect(f.calls).toEqual([2])
  })

  test("cancellation leaves cached state intact and does not launch queued requests", async () => {
    const f = await fixture(9)
    await f.sync()
    const abort = new AbortController()
    f.calls.length = 0
    f.client.listIssueComments = async (_cwd, number) => {
      f.calls.push(number)
      abort.abort()
      return []
    }
    await f.sync({ forceComments: true, signal: abort.signal })
    expect(f.calls).toEqual([1])
    expect(f.store.listIssueComments("test/repo", 1)).toEqual([{ id: 1, body: "original" }])
  })
})
