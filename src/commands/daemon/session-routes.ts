interface SessionRoutesContext {
  touchProject: (cwd: string) => void
  getKnownProjects: () => string[]
  getProjectLastSeen: (cwd: string) => number
  listProjectSessions: (
    cwd: string,
    limit: number,
    pinnedSessionId?: string
  ) => Promise<{ sessionCount: number; sessions: unknown[] }>
  getSessionData: (
    cwd: string,
    sessionId: string,
    limit: number
  ) => Promise<{ messages: unknown[]; toolStats: unknown[] }>
  getSessionTasks: (
    sessionId: string,
    limit: number
  ) => Promise<{
    tasks: unknown[]
    summary: { total: number; open: number; completed: number; cancelled: number }
  }>
  getProjectTasks: (
    cwd: string,
    limit: number
  ) => Promise<{
    tasks: unknown[]
    summary: { total: number; open: number; completed: number; cancelled: number }
  }>
}

export async function handleSessionRoutes(
  req: Request,
  url: URL,
  ctx: SessionRoutesContext
): Promise<Response | null> {
  if (url.pathname === "/sessions/projects" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      limitProjects?: number
      limitSessionsPerProject?: number
      selectedProjectCwd?: string
      selectedSessionId?: string
    } | null
    const limitProjects = Math.max(1, Math.min(30, body?.limitProjects ?? 8))
    const limitSessionsPerProject = Math.max(1, Math.min(30, body?.limitSessionsPerProject ?? 8))
    const projectCwds = [...new Set(ctx.getKnownProjects())]
    const ordered = projectCwds
      .map((cwd) => ({ cwd, lastSeenAt: ctx.getProjectLastSeen(cwd) }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limitProjects)

    const allProjects = await Promise.all(
      ordered.map(async ({ cwd, lastSeenAt }) => {
        const sessions = await ctx.listProjectSessions(
          cwd,
          limitSessionsPerProject,
          body?.selectedProjectCwd === cwd ? body?.selectedSessionId : undefined
        )
        return {
          cwd,
          name: cwd.split("/").at(-1) ?? cwd,
          lastSeenAt,
          sessionCount: sessions.sessionCount,
          sessions: sessions.sessions,
        }
      })
    )
    const projects = allProjects.filter((p) => p.sessionCount > 0)
    return Response.json({ projects })
  }

  if (url.pathname === "/sessions/messages" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      cwd?: string
      sessionId?: string
      limit?: number
    } | null
    const cwd = body?.cwd
    const sessionId = body?.sessionId
    if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string") {
      return Response.json(
        { error: "Missing required fields: cwd (string), sessionId (string)" },
        { status: 400 }
      )
    }
    ctx.touchProject(cwd)
    const limit = Math.max(1, Math.min(100, body?.limit ?? 30))
    const data = await ctx.getSessionData(cwd, sessionId, limit)
    return Response.json({ messages: data.messages, toolStats: data.toolStats })
  }

  if (url.pathname === "/sessions/tasks" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      cwd?: string
      sessionId?: string
      limit?: number
    } | null
    const cwd = body?.cwd
    const sessionId = body?.sessionId
    if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string") {
      return Response.json(
        { error: "Missing required fields: cwd (string), sessionId (string)" },
        { status: 400 }
      )
    }
    ctx.touchProject(cwd)
    const limit = Math.max(1, Math.min(100, body?.limit ?? 20))
    const data = await ctx.getSessionTasks(sessionId, limit)
    return Response.json(data)
  }

  if (url.pathname === "/projects/tasks" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      cwd?: string
      limit?: number
    } | null
    const cwd = body?.cwd
    if (typeof cwd !== "string" || cwd.length === 0) {
      return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
    }
    ctx.touchProject(cwd)
    const limit = Math.max(1, Math.min(300, body?.limit ?? 120))
    const data = await ctx.getProjectTasks(cwd, limit)
    return Response.json(data)
  }

  return null
}
