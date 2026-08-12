import { describe, expect, test } from "bun:test"

import { DaemonBackedIssueStore } from "./issue-store-daemon.ts"

interface GhQueryBody {
  args: string[]
  cwd: string
  ttlMs: number
}

describe("DaemonBackedIssueStore TTL forwarding", () => {
  test("preserves caller TTLs below and above the five-minute default", async () => {
    const bodies: GhQueryBody[] = []
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as GhQueryBody)
      return Response.json({ value: [], hit: false })
    }) as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)

    await store.listIssues("owner/repo", 60_000)
    await store.listPullRequests("owner/repo", 60 * 60 * 1000)
    await store.listLabels("owner/repo", 30_000)
    await store.listMilestones("owner/repo", 2 * 60 * 60 * 1000)

    expect(bodies.map((body) => body.ttlMs)).toEqual([
      60_000,
      60 * 60 * 1000,
      30_000,
      2 * 60 * 60 * 1000,
    ])
    expect(bodies.every((body) => body.cwd === ".")).toBe(true)
  })

  test("uses the five-minute TTL when the caller omits one", async () => {
    const bodies: GhQueryBody[] = []
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as GhQueryBody)
      return Response.json({ value: [], hit: false })
    }) as typeof fetch
    const store = new DaemonBackedIssueStore(fetchMock)

    await store.listIssues("owner/repo")

    expect(bodies[0]?.ttlMs).toBe(300_000)
  })
})
