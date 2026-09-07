import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { IssueStore } from "./issue-store.ts"
import { dashboardListSql } from "./issue-store-dashboard.ts"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-dashboard-store-")
const stores: IssueStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function fixture() {
  const path = join(await tmp.create(), "issues.db")
  const store = new IssueStore(path)
  stores.push(store)
  const records = Array.from({ length: 100 }, (_, i) => ({
    number: 100 - i,
    title: `Issue ${100 - i}`,
    body: "x".repeat(10000),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor((100 - i) / 2))).toISOString(),
    labels: [{ name: i % 2 ? "ready" : "backlog" }],
  }))
  store.upsertIssues("owner/repo", records)
  store.upsertPullRequests("owner/repo", records)
  store.upsertIssues("other/repo", [{ number: 999, title: "Other", updatedAt: "2030-01-01" }])
  store.upsertPullRequests("other/repo", [{ number: 999, title: "Other", updatedAt: "2030-01-01" }])
  return { store, path }
}

test("dashboard queries decode only the limit while full readers retain every record", async () => {
  const { store } = await fixture()
  for (const method of ["listDashboardIssues", "listDashboardPullRequests"] as const) {
    const parse = spyOn(JSON, "parse")
    try {
      const result = store[method]<{ number: number; labels: unknown[] }>("owner/repo", 10)
      expect(parse).toHaveBeenCalledTimes(10)
      expect(result.total).toBe(100)
      expect(result.records.map((row) => row.number)).toEqual([
        100, 98, 99, 96, 97, 94, 95, 92, 93, 90,
      ])
      expect(result.records.every((row) => row.labels.length === 1)).toBe(true)
    } finally {
      parse.mockRestore()
    }
    expect(store[method]("owner/repo", 1).records).toHaveLength(1)
    expect(store[method]("owner/repo", 1000).records).toHaveLength(30)
    expect(store[method]("owner/repo", Number.NaN).records).toHaveLength(10)
    expect(store[method]("owner/repo", 10, 0)).toEqual({ records: [], total: 0 })
    expect(store[method]("missing/repo", 10)).toEqual({ records: [], total: 0 })
  }
  expect(await store.asReader().listIssues("owner/repo")).toHaveLength(100)
  expect(await store.asReader().listPullRequests("owner/repo")).toHaveLength(100)
})

test("SQL filtering and timestamp order agree with dashboard normalization", async () => {
  const { store } = await fixture()
  const records = [
    { number: 1, title: "Offset", updatedAt: "2026-01-01T01:00:00+01:00" },
    { number: 2, title: "REST", updatedAt: "", updated_at: "2026-01-01T00:00:00Z" },
    { number: 3, title: "Invalid", updatedAt: "invalid", updated_at: "2030-01-01" },
    { number: 4, title: "Missing" },
    { number: 5, title: "", updatedAt: "2030-01-01" },
    { number: 6, title: "PR", pull_request: null, updatedAt: "2030-01-01" },
  ]
  store.upsertIssues("edge/repo", records)
  store.upsertPullRequests("edge/repo", records)
  expect(
    store.listDashboardIssues<{ number: number }>("edge/repo", 4).records.map((row) => row.number)
  ).toEqual([1, 2, 3, 4])
  expect(store.listDashboardIssues("edge/repo", 4).total).toBe(6)
  expect(
    store
      .listDashboardPullRequests<{ number: number }>("edge/repo", 4)
      .records.map((row) => row.number)
  ).toEqual([6, 1, 2, 3])
})

test("TTL applies before limiting and stale windows retain repo isolation", async () => {
  const { store, path } = await fixture()
  const db = new Database(path)
  try {
    for (const table of ["issues", "pull_requests"]) {
      db.run(`UPDATE ${table} SET synced_at = ? WHERE repo = ?`, [
        Date.now() - 600000,
        "owner/repo",
      ])
    }
    for (const method of ["listDashboardIssues", "listDashboardPullRequests"] as const) {
      expect(store[method]("owner/repo", 10)).toEqual({ records: [], total: 0 })
      const stale = store[method]("owner/repo", 10, 3600000)
      expect(stale.records).toHaveLength(10)
      expect(stale.total).toBe(100)
    }
  } finally {
    db.close()
  }
})

test("seeded planner uses existing repo indexes without a schema migration", async () => {
  const { path } = await fixture()
  const db = new Database(path)
  try {
    for (const table of ["issues", "pull_requests"] as const) {
      const plan = db
        .query<{ detail: string }, [string, number, number]>(
          `EXPLAIN QUERY PLAN ${dashboardListSql(table)}`
        )
        .all("owner/repo", 0, 10)
      expect(
        plan.some((row) =>
          row.detail.includes(`SEARCH ${table} USING INDEX sqlite_autoindex_${table}_1 (repo=?)`)
        )
      ).toBe(true)
      expect(plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true)
      expect(
        db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table)
      ).toHaveLength(1)
    }
  } finally {
    db.close()
  }
})
