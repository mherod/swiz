import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { projectKeyFromCwd } from "../../project-key.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import {
  getSessionData,
  listProjectSessions,
  providerSessionIndex,
  sessionDataCache,
} from "./session-data.ts"
import { handleSessionRoutes, type SessionRoutesContext } from "./session-routes.ts"

/**
 * Integrated dashboard-history polling (#809): the real `listProjectSessions` / `getSessionData`
 * behind `handleSessionRoutes`, real provider discovery against a temporary HOME, and the shared
 * module caches. Only the clock is controlled, so the two-second dashboard cadence and the
 * five-second provider freshness deadline are exercised as written, without real waiting.
 */

const { create: createTempDir } = useTempDir("swiz-history-polling-")
const POLL_MS = 2_000
const originalHome = process.env.HOME
let home: string
let projectCwd: string
let clock: number

function transcriptLine(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-29T10:00:00Z",
    message: { content: text },
  })}\n`
}

async function writeSession(cwd: string, sessionId: string, text: string): Promise<string> {
  const dir = join(home, ".claude", "projects", projectKeyFromCwd(cwd))
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await Bun.write(path, transcriptLine(text))
  return path
}

function routeContext(): SessionRoutesContext {
  return {
    touchProject: () => {},
    registerProjectWatchers: () => {},
    getKnownProjects: () => [projectCwd],
    getProjectLastSeen: () => clock,
    getProjectStatusLine: async () => "",
    listProjectSessions: (cwd, limit, pinned) => listProjectSessions(cwd, limit, undefined, pinned),
    getSessionData: (cwd, sessionId, limit) => getSessionData(cwd, sessionId, limit),
    getSessionTasks: async () => null,
    getProjectTasks: async () => ({ tasks: [] }) as never,
    getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
  }
}

async function post(path: string, body: object): Promise<any> {
  const req = new Request(`http://daemon${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const res = await handleSessionRoutes(req, new URL(req.url), routeContext())
  if (!res) throw new Error(`no route for ${path}`)
  expect(res.status).toBe(200)
  return res.json()
}

/** One dashboard poll: the project list and the selected session's messages. */
function poll(sessionId: string) {
  return Promise.all([
    post("/sessions/projects", { selectedProjectCwd: projectCwd, selectedSessionId: sessionId }),
    post("/sessions/messages", { cwd: projectCwd, sessionId, limit: 30 }),
  ])
}

function advance(ms: number): void {
  clock += ms
  setSystemTime(new Date(clock))
}

beforeAll(async () => {
  home = await realpath(await createTempDir())
  process.env.HOME = home
  projectCwd = join(home, "work", "project-a")
  await mkdir(projectCwd, { recursive: true })
})

afterAll(() => {
  setSystemTime()
  process.env.HOME = originalHome
})

beforeEach(() => {
  providerSessionIndex.clear()
  sessionDataCache.invalidateAll()
  clock = Date.parse("2026-09-29T12:00:00.000Z")
  setSystemTime(new Date(clock))
})

describe("dashboard history polling through the session routes (#809)", () => {
  test("twenty concurrent polls share one provider walk and see the same newest-first list", async () => {
    await writeSession(projectCwd, "session-old", "older")
    await writeSession(projectCwd, "session-new", "newer")
    const before = providerSessionIndex.getMetrics()

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        post("/sessions/projects", { selectedProjectCwd: projectCwd })
      )
    )

    const after = providerSessionIndex.getMetrics()
    expect(after.misses - before.misses).toBe(1)
    expect(after.coalesced - before.coalesced).toBe(19)
    const orders = results.map((r) => r.projects[0].sessions.map((s: { id: string }) => s.id))
    for (const order of orders) expect(order).toEqual(orders[0])
    expect(orders[0]).toHaveLength(2)
  })

  test("twenty unchanged two-second polls re-read no transcript bytes and walk only at the freshness deadline", async () => {
    await writeSession(projectCwd, "session-a", "hello")
    const [, warmMessages] = await poll("session-a")
    expect(warmMessages.messages.map((m: { text: string }) => m.text)).toEqual(["hello"])

    const providerBefore = providerSessionIndex.getMetrics()
    const readsBefore = sessionDataCache.getReadStats()
    for (let cycle = 0; cycle < 20; cycle++) {
      advance(POLL_MS)
      const [, messages] = await poll("session-a")
      expect(messages.revision).toBe(warmMessages.revision)
    }
    const providerAfter = providerSessionIndex.getMetrics()
    const readsAfter = sessionDataCache.getReadStats()

    // Zero transcript body reads after warm-up: every poll is a cache hit.
    expect(readsAfter.bodyBytesRead).toBe(readsBefore.bodyBytesRead)
    expect(readsAfter.coldRebuilds).toBe(readsBefore.coldRebuilds)
    expect(readsAfter.appends).toBe(readsBefore.appends)
    // Every provider walk in the window is an attributed five-second validation, never unexplained.
    const walks = providerAfter.misses - providerBefore.misses
    const staleRefreshes = providerAfter.staleRefreshes - providerBefore.staleRefreshes
    expect(walks).toBe(staleRefreshes)
    // 40 s of polling at a 5 s deadline revalidates at 6 s, 12 s, ... 36 s: exactly 6 times.
    expect(staleRefreshes).toBe(6)
  })

  test("a session added after validation appears on the first poll at the deadline, with one coalesced refresh", async () => {
    await writeSession(projectCwd, "session-a", "hello")
    await post("/sessions/projects", { selectedProjectCwd: projectCwd })

    await writeSession(projectCwd, "session-late", "late")
    advance(4_999)
    const early = await post("/sessions/projects", { selectedProjectCwd: projectCwd })
    expect(early.projects[0].sessions.map((s: { id: string }) => s.id)).not.toContain(
      "session-late"
    )

    advance(1)
    const before = providerSessionIndex.getMetrics()
    const atDeadline = await Promise.all(
      Array.from({ length: 10 }, () =>
        post("/sessions/projects", { selectedProjectCwd: projectCwd })
      )
    )
    const after = providerSessionIndex.getMetrics()
    expect(after.misses - before.misses).toBe(1)
    for (const result of atDeadline) {
      expect(result.projects[0].sessions.map((s: { id: string }) => s.id)).toContain("session-late")
    }
  })

  test("an appended line reads only the new bytes on the next poll", async () => {
    const path = await writeSession(projectCwd, "session-a", "first")
    await poll("session-a")
    const before = sessionDataCache.getReadStats()

    const added = transcriptLine("second")
    await Bun.write(path, `${await Bun.file(path).text()}${added}`)
    advance(POLL_MS)
    const [, messages] = await poll("session-a")

    const after = sessionDataCache.getReadStats()
    expect(messages.messages.map((m: { text: string }) => m.text)).toEqual(["first", "second"])
    expect(after.appends - before.appends).toBe(1)
    expect(after.bodyBytesRead - before.bodyBytesRead).toBe(Buffer.byteLength(added))
    expect(after.coldRebuilds).toBe(before.coldRebuilds)
  })
})
