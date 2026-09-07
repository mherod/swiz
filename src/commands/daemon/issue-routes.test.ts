import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IssueStore, type UpstreamSyncResult } from "../../issue-store.ts"
import {
  handleProjectIssuesRoute,
  handleProjectPrsRoute,
  handleProjectSyncNow,
  type IssueRoutesContext,
} from "./issue-routes.ts"
import { UpstreamSyncRegistry } from "./upstream-sync.ts"

const cleanups: Array<() => Promise<void>> = []
const registries: UpstreamSyncRegistry[] = []

afterAll(async () => {
  for (const registry of registries.splice(0)) registry.close()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function syncResult(): UpstreamSyncResult {
  const bucket = () => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
  const tracked = () => ({ upserted: 0, changes: [] })
  return {
    issues: bucket(),
    pullRequests: bucket(),
    ciStatuses: tracked(),
    comments: { upserted: 0 },
    labels: bucket(),
    milestones: bucket(),
    branchCi: tracked(),
    prBranchDetail: tracked(),
    branchProtection: tracked(),
    events: { inserted: 0, cursor: null },
    restCache: { requests: 0, notModified: 0, writes: 0 },
    fetchOk: true,
  }
}

function createContext(
  options: { repo?: string; onSync?: (repo: string) => void } = {}
): IssueRoutesContext {
  const repo = options.repo ?? "test-owner/test-repo"
  const upstreamSyncRegistry = new UpstreamSyncRegistry({
    resolveSlug: async () => repo,
    resolveFork: async () => null,
    sync: async (slug) => {
      options.onSync?.(slug)
      return syncResult()
    },
  })
  registries.push(upstreamSyncRegistry)
  return {
    touchProject: () => {},
    registerProjectWatchers: () => {},
    upstreamSyncRegistry,
  }
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "swiz-issue-route-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(stderr)
}

async function dashboardFixture() {
  const cwd = await createTempDirectory()
  const repo = `route-tests/${crypto.randomUUID()}`
  await runGit(cwd, ["init", "--quiet"])
  await runGit(cwd, ["remote", "add", "origin", `https://github.com/${repo}.git`])
  const path = join(cwd, "store.db")
  const store = new IssueStore(path)
  cleanups.unshift(async () => store.close())
  const ctx = createContext({ repo })
  ctx.issueStoreReader = store.asReader()
  return { cwd, repo, path, store, ctx }
}

describe("issue routes", () => {
  test("dashboard issue and PR routes retain order, labels and displayed totals", async () => {
    const { cwd, repo, store, ctx } = await dashboardFixture()
    const records = Array.from({ length: 40 }, (_, i) => ({
      number: i + 1,
      title: `Item ${i + 1}`,
      updatedAt: "2026-01-01T00:00:00Z",
      labels: [{ name: i % 2 ? "ready" : "backlog" }],
    }))
    store.upsertIssues(repo, records)
    store.upsertPullRequests(repo, records)
    ctx.issueStoreReader!.listIssues = async () => {
      throw new Error("Unexpected complete-list read")
    }
    ctx.issueStoreReader!.listPullRequests = async () => {
      throw new Error("Unexpected complete-list read")
    }
    for (const [handler, key] of [
      [handleProjectIssuesRoute, "issues"],
      [handleProjectPrsRoute, "pullRequests"],
    ] as const) {
      const body = await handler(
        new Request("http://daemon/projects/list", {
          method: "POST",
          body: JSON.stringify({ cwd, limit: 10 }),
        }),
        ctx
      ).then((response) => response.json())
      expect(body.syncing).toBe(false)
      expect(body[key]).toHaveLength(10)
      expect(body[key].map((row: { number: number }) => row.number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ])
      if (key === "issues") expect(body.issues[1].labels[0].name).toBe("ready")
    }
  })

  test("empty fresh windows serve bounded stale rows and malformed fresh rows do not trigger sync", async () => {
    const { cwd, repo, path, store, ctx } = await dashboardFixture()
    store.upsertIssues(
      repo,
      Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `Stale ${i}` }))
    )
    store.upsertPullRequests(
      repo,
      Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `Stale ${i}` }))
    )
    const db = new Database(path)
    for (const table of ["issues", "pull_requests"])
      db.run(`UPDATE ${table} SET synced_at = ?`, [Date.now() - 600000])
    db.close()
    for (const [handler, key] of [
      [handleProjectIssuesRoute, "issues"],
      [handleProjectPrsRoute, "pullRequests"],
    ] as const) {
      const body = await handler(
        new Request("http://daemon/projects/list", {
          method: "POST",
          body: JSON.stringify({ cwd, limit: 4 }),
        }),
        ctx
      ).then((response) => response.json())
      expect(body.syncing).toBe(true)
      expect(body[key]).toHaveLength(4)
    }
    store.upsertIssues(repo, [{ number: 100, title: "" }])
    const body = await handleProjectIssuesRoute(
      new Request("http://daemon/projects/issues", {
        method: "POST",
        body: JSON.stringify({ cwd }),
      }),
      ctx
    ).then((response) => response.json())
    expect(body.syncing).toBe(false)
    expect(body.issues).toEqual([])
  })

  test("rejects missing cwd for issue and pull-request requests", async () => {
    const ctx = createContext()
    const req = new Request("http://daemon/project/issues", {
      method: "POST",
      body: "{}",
    })

    expect((await handleProjectIssuesRoute(req.clone(), ctx)).status).toBe(400)
    expect((await handleProjectPrsRoute(req.clone(), ctx)).status).toBe(400)
  })

  test("returns empty lists when cwd is not a GitHub repository", async () => {
    const cwd = await createTempDirectory()
    const ctx = createContext()
    const issueReq = new Request("http://daemon/project/issues", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    })
    const prReq = new Request("http://daemon/project/prs", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    })

    expect(
      await handleProjectIssuesRoute(issueReq, ctx).then((response) => response.json())
    ).toEqual({ repo: null, issues: [] })
    expect(await handleProjectPrsRoute(prReq, ctx).then((response) => response.json())).toEqual({
      repo: null,
      pullRequests: [],
    })
  })

  test("registers and starts an explicit project sync", async () => {
    const cwd = await createTempDirectory()
    const synced: string[] = []
    const ctx = createContext({ onSync: (repo) => synced.push(repo) })
    const req = new Request("http://daemon/project/sync", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    })

    expect(await handleProjectSyncNow(req, ctx).then((response) => response.json())).toEqual({
      ok: true,
      started: true,
    })
    await Bun.sleep(10)

    expect(synced).toEqual(["test-owner/test-repo"])
  })

  test("schedules background sync when a known repository has no stored issues", async () => {
    const cwd = await createTempDirectory()
    const uniqueRepo = `route-tests/repo-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await mkdir(join(cwd, "work"), { recursive: true })
    const repoRoot = join(cwd, "work")
    await runGit(repoRoot, ["init", "--quiet"])
    await runGit(repoRoot, ["remote", "add", "origin", `https://github.com/${uniqueRepo}.git`])

    const synced: string[] = []
    const ctx = createContext({ repo: uniqueRepo, onSync: (repo) => synced.push(repo) })
    const req = new Request("http://daemon/project/issues", {
      method: "POST",
      body: JSON.stringify({ cwd: repoRoot }),
    })

    const body = await handleProjectIssuesRoute(req, ctx).then((response) => response.json())
    await Bun.sleep(10)

    expect(body).toMatchObject({ repo: uniqueRepo, issues: [], syncing: true })
    expect(synced).toEqual([uniqueRepo])
  })
})
