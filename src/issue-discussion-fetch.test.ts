import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import {
  getGhRateLimitStats,
  observeGhRateLimitHeaders,
  resetGhRateLimitStateForTests,
} from "./gh-rate-limit.ts"
import { fetchIssueDiscussion } from "./issue-discussion-fetch.ts"
import { IssueStore } from "./issue-store.ts"
import { useTempDir } from "./utils/test-utils.ts"

const temp = useTempDir("discussion-fetch-")
const originalSpawn = Bun.spawn
const stores: IssueStore[] = []
beforeEach(() => {
  resetGhRateLimitStateForTests()
  observeGhRateLimitHeaders({
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "5000",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  })
})
afterEach(() => {
  Bun.spawn = originalSpawn
  resetGhRateLimitStateForTests()
  for (const store of stores.splice(0)) store.close()
})

function transport(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>
) {
  const calls: string[][] = []
  Bun.spawn = ((command: string[]) => {
    calls.push(command)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected API request")
    const output = [
      `HTTP/2 ${response.status}`,
      ...Object.entries(response.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
      "",
      JSON.stringify(response.body ?? []),
    ].join("\r\n")
    return {
      exited: Promise.resolve(0),
      exitCode: response.status >= 400 ? 1 : 0,
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
    } as unknown as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn
  return calls
}

async function fixture() {
  const cwd = await temp.create()
  const store = new IssueStore(join(cwd, "issues.db"))
  stores.push(store)
  return { cwd, store, repo: "test/repo", issueNumber: 1 }
}

test("revalidates cached pages and consumes one global budget slot per request", async () => {
  const f = await fixture()
  const calls = transport([
    {
      status: 200,
      body: [{ id: 1, body: "owner comment", user: { login: "owner" }, created_at: "2026-01-01" }],
      headers: { etag: '"v1"' },
    },
    { status: 304 },
  ])
  const first = await fetchIssueDiscussion(f)
  expect(await fetchIssueDiscussion(f)).toEqual(first)
  expect(first?.[0]?.author?.login).toBe("owner")
  expect(calls[1]).toContain('If-None-Match: "v1"')
  expect((await getGhRateLimitStats()).remaining).toBe(4998)
})

test("loads chronological pages and rechecks later pages after a 304", async () => {
  const f = await fixture()
  const page = Array.from({ length: 100 }, (_, id) => ({ id: id + 1 }))
  const calls = transport([
    { status: 200, body: page, headers: { etag: '"page1"' } },
    { status: 200, body: [{ id: 101, body: "old" }], headers: { etag: '"page2"' } },
    { status: 304 },
    { status: 200, body: [{ id: 101, body: "edited" }] },
  ])
  expect(await fetchIssueDiscussion(f)).toHaveLength(101)
  const refreshed = await fetchIssueDiscussion(f)
  expect(refreshed?.map((comment) => comment.id)).toEqual([
    ...page.map((comment) => comment.id),
    101,
  ])
  expect(refreshed?.[100]?.body).toBe("edited")
  expect(calls[3]).toContain('If-None-Match: "page2"')
})

test("does not return a partial thread when a later page fails", async () => {
  const f = await fixture()
  transport([
    { status: 200, body: Array.from({ length: 100 }, (_, id) => ({ id })) },
    { status: 503 },
  ])
  expect(await fetchIssueDiscussion(f)).toBeNull()
})

test("honors retry-after even when a failed response has no ETag", async () => {
  const f = await fixture()
  transport([{ status: 403, headers: { "retry-after": "1" } }, { status: 200 }])
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined)
  try {
    expect(await fetchIssueDiscussion(f)).toBeNull()
    expect(await fetchIssueDiscussion(f)).toEqual([])
    expect(sleep).toHaveBeenCalled()
  } finally {
    sleep.mockRestore()
  }
})

test("cancelled reads never launch a request", async () => {
  const f = await fixture()
  const calls = transport([])
  expect(await fetchIssueDiscussion({ ...f, signal: AbortSignal.abort() })).toBeNull()
  expect(calls).toEqual([])
})
