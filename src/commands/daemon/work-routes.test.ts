import { expect, test } from "bun:test"
import type { FileOwnershipResult } from "../../file-ownership-tool.ts"
import { canonicalClaimPath } from "../../session-file-claims.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import type { SessionRoutesContext } from "./session-routes.ts"
import { handleWorkRoutes } from "./work-routes.ts"

const tmp = useTempDir("swiz-work-routes-")
function context(cwd: string): SessionRoutesContext {
  return {
    touchProject: () => {},
    registerProjectWatchers: () => {},
    getKnownProjects: () => [cwd, cwd, "."],
    getProjectLastSeen: () => 1,
    getProjectStatusLine: async () => "",
    listProjectSessions: async () => ({
      sessionCount: 1,
      sessions: [{ id: "session", provider: "codex", mtime: 1 }],
    }),
    getSessionData: async () => ({ messages: [], toolStats: [] }),
    getSessionTasks: async () => null,
    getProjectTasks: async () => ({
      tasks: [],
      summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
    }),
    getAgentProcessSnapshot: async () => ({ providers: { codex: [123] }, pidCwds: { 123: cwd } }),
  }
}
const readers = {
  deadlines: async () => [],
  ownership: async (cwd: string): Promise<FileOwnershipResult> => ({
    action: "list",
    cwd,
    ok: true,
    claims: [],
    conflicts: [],
    missing: [],
    released: [],
    nonexistentPaths: [],
    duplicates: [],
    recentEdits: [],
    unresolvedEdits: [],
    historyWarnings: [],
  }),
}
function request(path: string, body?: unknown) {
  return new Request(
    `http://localhost${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  )
}

test("work projects include projects without transcripts and remove duplicates", async () => {
  const cwd = await tmp.create()
  const req = request("/work/projects")
  const response = await handleWorkRoutes(req, new URL(req.url), context(cwd), readers)
  expect((await response!.json()).projects.map((p: { cwd: string }) => p.cwd)).toEqual([cwd])
})

test("snapshot scopes each source and annotates provider process evidence", async () => {
  const cwd = canonicalClaimPath(await tmp.create())
  const seen: string[] = []
  const req = request("/projects/work", { cwd })
  const response = await handleWorkRoutes(req, new URL(req.url), context(cwd), {
    ...readers,
    deadlines: async (path) => {
      seen.push(path)
      return []
    },
  })
  const body = await response!.json()
  expect(seen).toEqual([cwd])
  expect(body.cwd).toBe(cwd)
  expect(body.tasks.summary.total).toBe(0)
  expect(body.sessions.sessions[0].processAlive).toBe(true)
  expect(body.sessions.processStatusAvailable).toBe(true)
  expect(body.ownership.action).toBe("list")
  expect(body.errors).toEqual({})
})

test("failed sources stay distinct from empty sources and preserve usable sections", async () => {
  const cwd = await tmp.create()
  const ctx = context(cwd)
  ctx.getProjectTasks = async () => {
    throw new Error("Task store unavailable")
  }
  ctx.getAgentProcessSnapshot = async () => {
    throw new Error("Process scan unavailable")
  }
  const req = request("/projects/work", { cwd })
  const response = await handleWorkRoutes(req, new URL(req.url), ctx, readers)
  const body = await response!.json()
  expect(response!.status).toBe(200)
  expect(body.tasks).toBeNull()
  expect(body.deadlines).toEqual([])
  expect(body.sessions.sessions).toHaveLength(1)
  expect(body.sessions.processStatusAvailable).toBe(false)
  expect(body.errors).toEqual({
    tasks: "Task store unavailable",
    processes: "Process scan unavailable",
  })
})

test("rejects invalid project inputs before reading stores", async () => {
  const cwd = await tmp.create()
  for (const body of [
    null,
    {},
    { cwd: "." },
    { cwd: 123 },
    { cwd: "/missing-project-for-swiz-work" },
  ]) {
    const req = request("/projects/work", body)
    const response = await handleWorkRoutes(req, new URL(req.url), context(cwd), readers)
    expect(response!.status).toBe(400)
  }
  const req = request("/projects/work")
  expect(await handleWorkRoutes(req, new URL(req.url), context(cwd), readers)).toBeNull()
})
