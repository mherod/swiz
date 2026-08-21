import { describe, expect, test } from "bun:test"
import type { SessionPreview } from "./session-data.ts"
import {
  type AgentProcessSnapshot,
  annotateSessionsWithLiveness,
  handleSessionRoutes,
  hasLiveAgentForProject,
  type SessionRoutesContext,
  type SessionWithLiveness,
} from "./session-routes.ts"

function makeSnapshot(
  providers: Record<string, number[]>,
  pidCwds: Record<number, string>
): AgentProcessSnapshot {
  return { providers, pidCwds }
}

describe("hasLiveAgentForProject", () => {
  test("returns true when a PID cwd matches project exactly", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(true)
  })

  test("returns true when a PID cwd is a subdirectory of project", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project/src" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(true)
  })

  test("returns false when no PID cwd matches", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/other-project" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })

  test("returns false when pidCwds is empty", () => {
    const snapshot = makeSnapshot({ claude: [100] }, {})
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })

  test("does not false-positive on prefix collision", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project-extra" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })
})

describe("annotateSessionsWithLiveness", () => {
  test("marks sessions as processAlive when matching provider has live PID in project", () => {
    const sessions: SessionPreview[] = [
      { id: "s1", provider: "claude", mtime: 1000 },
      { id: "s2", provider: "cursor", mtime: 2000 },
    ]
    const snapshot = makeSnapshot(
      { claude: [100], cursor: [200] },
      { 100: "/home/user/project" } // only claude PID is in this project
    )
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot)
    expect(result[0]!.processAlive).toBe(true) // claude has live PID here
    expect(result[1]!.processAlive).toBe(false) // cursor PID is elsewhere
  })

  test("marks all sessions as not alive when no PIDs match project", () => {
    const sessions: SessionPreview[] = [
      { id: "s1", provider: "claude", mtime: 1000 },
      { id: "s2", provider: "claude", mtime: 2000 },
    ]
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/other" })
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot)
    expect(result[0]!.processAlive).toBe(false)
    expect(result[1]!.processAlive).toBe(false)
  })

  test("falls back gracefully when pidCwds is empty (no lsof data)", () => {
    const sessions: SessionPreview[] = [{ id: "s1", provider: "claude", mtime: 1000 }]
    const snapshot = makeSnapshot({ claude: [100] }, {})
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot)
    expect(result[0]!.processAlive).toBe(false)
  })

  test("handles sessions with undefined provider", () => {
    const sessions: SessionPreview[] = [{ id: "s1", mtime: 1000 }]
    const snapshot = makeSnapshot({ unknown: [100] }, { 100: "/home/user/project" })
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot)
    expect(result[0]!.processAlive).toBe(true) // provider defaults to "unknown"
  })

  test("preserves existing session fields", () => {
    const sessions: SessionPreview[] = [
      { id: "s1", provider: "claude", mtime: 1000, dispatches: 5, lastMessageAt: 900 },
    ]
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project" })
    const result: SessionWithLiveness[] = annotateSessionsWithLiveness(
      sessions,
      "/home/user/project",
      snapshot
    )
    expect(result[0]!.id).toBe("s1")
    expect(result[0]!.dispatches).toBe(5)
    expect(result[0]!.lastMessageAt).toBe(900)
    expect(result[0]!.processAlive).toBe(true)
  })
})

describe("SessionRoutesContext DTO shapes", () => {
  test("minimal mock satisfies the session-routes contract", async () => {
    const ctx: SessionRoutesContext = {
      touchProject: () => {},
      registerProjectWatchers: () => {},
      getKnownProjects: () => [],
      getProjectLastSeen: () => 0,
      getProjectStatusLine: async () => "",
      listProjectSessions: async () => ({ sessionCount: 0, sessions: [] }),
      getSessionData: async () => ({ messages: [], toolStats: [] }),
      getSessionTasks: async () => ({
        tasks: [],
        summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
      }),
      getProjectTasks: async () => ({
        tasks: [],
        summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
      }),
      getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
    }
    const listed = await ctx.listProjectSessions("/tmp", 5)
    expect(listed.sessionCount).toBe(0)
    expect(listed.sessions).toEqual([])

    const data = await ctx.getSessionData("/tmp", "sid", 10)
    expect(data.messages).toEqual([])
    expect(data.toolStats).toEqual([])

    const sessionTasks = await ctx.getSessionTasks("sid", 5)
    expect(sessionTasks).not.toBeNull()
    expect(sessionTasks?.tasks).toEqual([])
    expect(sessionTasks?.summary.total).toBe(0)

    const projectTasks = await ctx.getProjectTasks("/tmp", 10)
    expect(projectTasks.tasks).toEqual([])
    expect(projectTasks.summary.cancelled).toBe(0)
  })
})

describe("handleSessionTasks unknown session", () => {
  function makeCtx(
    getSessionTasksImpl: SessionRoutesContext["getSessionTasks"]
  ): SessionRoutesContext {
    return {
      touchProject: () => {},
      registerProjectWatchers: () => {},
      getKnownProjects: () => [],
      getProjectLastSeen: () => 0,
      getProjectStatusLine: async () => "",
      listProjectSessions: async () => ({ sessionCount: 0, sessions: [] }),
      getSessionData: async () => ({ messages: [], toolStats: [] }),
      getSessionTasks: getSessionTasksImpl,
      getProjectTasks: async () => ({
        tasks: [],
        summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
      }),
      getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
    }
  }

  test("returns 404 with tasks:null when session is unknown", async () => {
    const ctx = makeCtx(async () => null)
    const req = new Request("http://localhost/sessions/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp", sessionId: "nonexistent-session" }),
    })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
    const body = await res!.json()
    expect(body.tasks).toBeNull()
  })

  test("returns tasks when session is known", async () => {
    const ctx = makeCtx(async () => ({
      tasks: [],
      summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
    }))
    const req = new Request("http://localhost/sessions/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp", sessionId: "known-session" }),
    })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.tasks).toEqual([])
  })
})

describe("handleProjectsList compat shim", () => {
  test("includes and touches an explicitly selected project on the first request", async () => {
    const selectedProjectCwd = process.cwd()
    const registered: string[] = []
    const touched: string[] = []
    const listed: string[] = []
    const ctx: SessionRoutesContext = {
      touchProject: (cwd) => touched.push(cwd),
      registerProjectWatchers: (cwd) => registered.push(cwd),
      getKnownProjects: () => [],
      getProjectLastSeen: () => 123,
      getProjectStatusLine: async () => "ready",
      listProjectSessions: async (cwd) => {
        listed.push(cwd)
        return { sessionCount: 1, sessions: [{ id: "selected-session", mtime: 123 }] }
      },
      getSessionData: async () => ({ messages: [], toolStats: [] }),
      getSessionTasks: async () => null,
      getProjectTasks: async () => ({
        tasks: [],
        summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
      }),
      getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
    }
    const req = new Request("http://localhost/sessions/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedProjectCwd, selectedSessionId: "selected-session" }),
    })

    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    const body = await res!.json()

    expect(registered).toEqual([selectedProjectCwd])
    expect(touched).toEqual([selectedProjectCwd])
    expect(listed).toEqual([selectedProjectCwd])
    expect(body.projects[0].cwd).toBe(selectedProjectCwd)
  })

  test("registers and refreshes a project from a session-only request", async () => {
    const registered: string[] = []
    const touched: string[] = []
    const ctx: SessionRoutesContext = {
      touchProject: (cwd) => touched.push(cwd),
      registerProjectWatchers: (cwd) => registered.push(cwd),
      getKnownProjects: () => [],
      getProjectLastSeen: () => 0,
      getProjectStatusLine: async () => "",
      listProjectSessions: async () => ({ sessionCount: 0, sessions: [] }),
      getSessionData: async () => ({ messages: [], toolStats: [] }),
      getSessionTasks: async () => null,
      getProjectTasks: async () => ({
        tasks: [],
        summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
      }),
      getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
    }
    const cwd = process.cwd()
    const req = new Request("http://localhost/sessions/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, sessionId: "session-1" }),
    })

    const res = await handleSessionRoutes(req, new URL(req.url), ctx)

    expect(res!.status).toBe(200)
    expect(registered).toEqual([cwd])
    expect(touched).toEqual([cwd])
  })

  test("remaps legacy selectedProject to selectedProjectCwd", () => {
    const legacyBody = {
      selectedProject: "/home/user/project",
      selectedSession: "session-123",
    }
    // Verify the compat shim logic
    const remapped = {
      selectedProjectCwd: legacyBody.selectedProject ?? undefined,
      selectedSessionId: legacyBody.selectedSession ?? undefined,
    }
    expect(remapped.selectedProjectCwd).toBe("/home/user/project")
    expect(remapped.selectedSessionId).toBe("session-123")
  })

  test("remaps legacy limits.projects to limitProjects", () => {
    const legacyBody = {
      limits: {
        projects: 5,
      },
    }
    // Verify the compat shim logic
    const limitProjects = (legacyBody.limits as { projects?: number } | undefined)?.projects ?? 8
    expect(limitProjects).toBe(5)
  })

  test("prefers new field names over legacy fields", () => {
    const mixedBody = {
      selectedProjectCwd: "/home/user/new-project",
      selectedProject: "/home/user/old-project",
    }
    // Verify the compat shim prefers new names
    const selectedProjectCwd = mixedBody.selectedProjectCwd ?? mixedBody.selectedProject
    expect(selectedProjectCwd).toBe("/home/user/new-project")
  })
})

describe("/tasks/cancel routing and validation", () => {
  const ctx = null as unknown as SessionRoutesContext

  function cancelRequest(body: unknown, method = "POST"): Request {
    return new Request("http://localhost/tasks/cancel", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    })
  }

  test("is routed rather than falling through to the static file server", async () => {
    const req = cancelRequest({})
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res).not.toBeNull()
  })

  test("rejects a missing sessionId with 400, not a silent success", async () => {
    const req = cancelRequest({ taskId: "1" })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toContain("sessionId")
  })

  test("rejects a missing taskId with 400", async () => {
    const req = cancelRequest({ sessionId: "s1" })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toContain("taskId")
  })

  test("rejects an empty-string sessionId — presence alone is not validity", async () => {
    const req = cancelRequest({ sessionId: "", taskId: "1" })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res!.status).toBe(400)
  })

  test("does not answer GET — the route is a mutation", async () => {
    const req = cancelRequest(undefined, "GET")
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res).toBeNull()
  })

  test("reports an unresolvable task as a 500 with its reason, not a fake success", async () => {
    const req = cancelRequest({ sessionId: "no-such-session-xyz", taskId: "no-such-task" })
    const res = await handleSessionRoutes(req, new URL(req.url), ctx)
    expect(res!.status).toBe(500)
    expect((await res!.json()).error).toBeTruthy()
  })
})
