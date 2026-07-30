import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

let cachedProcesses: {
  providers: Record<string, number[]>
  pidCwds: Record<number, string>
} = { providers: { codex: [42] }, pidCwds: { 42: "/repo" } }
let matchedSessions: Array<{ id: string; provider?: string }> = [
  { id: "session", provider: "Codex" },
]
let deleteCalls = 0

void mock.module("./agent-process-discovery.ts", () => ({
  getActiveAgentProcesses: async () => cachedProcesses,
  getCachedAgentProcesses: async () => cachedProcesses,
  getProcessCommand: async () => null,
  isCursorMacProcess: () => false,
}))

void mock.module("../../session-data-delete.ts", () => ({
  resolveSessionDeletionTargets: async () => ({
    matchedSessions,
    paths: [],
  }),
  deleteSessionData: async () => {
    deleteCalls++
    return { failedPaths: [], deletedCount: 1, sessionIds: ["session"] }
  },
}))

let routes: typeof import("./process-routes.ts")

beforeAll(async () => {
  routes = await import("./process-routes.ts")
})

beforeEach(() => {
  cachedProcesses = { providers: { codex: [42] }, pidCwds: { 42: "/repo" } }
  matchedSessions = [{ id: "session", provider: "Codex" }]
  deleteCalls = 0
})

function post(body: Record<string, unknown>): Request {
  return new Request("http://daemon/process", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("process routes", () => {
  test("rejects unsafe or missing process identifiers", async () => {
    for (const pid of [undefined, 0, 1, -1, 1.5, "42"]) {
      const response = await routes.handleProcessKill(post(pid === undefined ? {} : { pid }))
      expect(response.status).toBe(400)
    }
  })

  test("validates session deletion input", async () => {
    const response = await routes.handleSessionDelete(post({ cwd: "/repo" }))
    expect(response.status).toBe(400)
  })

  test("reports missing sessions", async () => {
    matchedSessions = []
    const response = await routes.handleSessionDelete(post({ cwd: "/repo", sessionId: "missing" }))

    expect(response.status).toBe(404)
    expect(deleteCalls).toBe(0)
  })

  test("blocks deletion while the matching provider is active", async () => {
    const response = await routes.handleSessionDelete(post({ cwd: "/repo", sessionId: "session" }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Cannot delete session while provider process is active",
      providers: { codex: [42] },
    })
    expect(deleteCalls).toBe(0)
  })

  test("deletes sessions when no matching provider process is active", async () => {
    cachedProcesses = { providers: {}, pidCwds: {} }
    const response = await routes.handleSessionDelete(post({ cwd: "/repo", sessionId: "session" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      deletedCount: 1,
      sessionIds: ["session"],
    })
    expect(deleteCalls).toBe(1)
  })

  test("returns the cached agent process snapshot", async () => {
    expect(await routes.handleProcessAgents().then((response) => response.json())).toEqual(
      cachedProcesses
    )
  })
})
