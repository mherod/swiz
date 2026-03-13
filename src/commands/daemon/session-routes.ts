export interface AgentProcessSnapshot {
  providers: Record<string, number[]>
  pidCwds: Record<number, string>
}

interface SessionRoutesContext {
  touchProject: (cwd: string) => void
  getKnownProjects: () => string[]
  getProjectLastSeen: (cwd: string) => number
  getProjectStatusLine: (cwd: string, sessionId?: string) => Promise<string>
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
  getAgentProcessSnapshot: () => Promise<AgentProcessSnapshot>
}

/** Check if any agent process has a cwd that is within the given project directory. */
export function hasLiveAgentForProject(
  projectCwd: string,
  snapshot: AgentProcessSnapshot
): boolean {
  for (const cwd of Object.values(snapshot.pidCwds)) {
    if (cwd === projectCwd || cwd.startsWith(projectCwd + "/")) return true
  }
  return false
}

/** Get PIDs of agent processes whose cwd is within the given project directory. */
function getProjectAgentPids(projectCwd: string, snapshot: AgentProcessSnapshot): number[] {
  const pids: number[] = []
  for (const [pidStr, cwd] of Object.entries(snapshot.pidCwds)) {
    if (cwd === projectCwd || cwd.startsWith(projectCwd + "/")) {
      pids.push(Number(pidStr))
    }
  }
  return pids.sort((a, b) => a - b)
}

/** Annotate sessions with processAlive based on agent process cwds matching project cwd. */
export function annotateSessionsWithLiveness(
  sessions: unknown[],
  projectCwd: string,
  snapshot: AgentProcessSnapshot
): unknown[] {
  const projectHasLiveAgent = hasLiveAgentForProject(projectCwd, snapshot)
  if (!projectHasLiveAgent) {
    return sessions.map((s) => ({ ...(s as Record<string, unknown>), processAlive: false }))
  }
  const projectPids = new Set(getProjectAgentPids(projectCwd, snapshot))
  // Map provider -> whether it has a live PID in this project
  const liveProviders = new Set<string>()
  for (const [provider, pids] of Object.entries(snapshot.providers)) {
    if (pids.some((pid) => projectPids.has(pid))) liveProviders.add(provider)
  }
  return sessions.map((s) => {
    const session = s as Record<string, unknown>
    const provider = ((session.provider as string) ?? "unknown").toLowerCase()
    return { ...session, processAlive: liveProviders.has(provider) }
  })
}

export async function handleSessionRoutes(
  req: Request,
  url: URL,
  ctx: SessionRoutesContext
): Promise<Response | null> {
  if (url.pathname === "/sessions/projects" && req.method === "POST") {
    try {
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

      const agentSnapshot = await ctx.getAgentProcessSnapshot()

      const allProjects = await Promise.all(
        ordered.map(async ({ cwd, lastSeenAt }) => {
          try {
            const pinnedSessionId =
              body?.selectedProjectCwd === cwd ? body?.selectedSessionId : undefined
            const sessions = await ctx.listProjectSessions(
              cwd,
              limitSessionsPerProject,
              pinnedSessionId
            )
            const firstSession = (sessions.sessions as Array<{ id?: string }>)[0]
            const statusLine = await ctx.getProjectStatusLine(
              cwd,
              pinnedSessionId ??
                (typeof firstSession?.id === "string" ? firstSession.id : undefined)
            )
            return {
              cwd,
              name: cwd.split("/").at(-1) ?? cwd,
              lastSeenAt,
              sessionCount: sessions.sessionCount,
              sessions: annotateSessionsWithLiveness(sessions.sessions, cwd, agentSnapshot),
              statusLine,
            }
          } catch {
            // Ignore a single project failure so one bad transcript cannot break the dashboard.
            return null
          }
        })
      )
      const projects = allProjects.filter(
        (project): project is NonNullable<typeof project> =>
          project !== null && project.sessionCount > 0
      )
      return Response.json({ projects })
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load sessions projects due to an internal error",
        },
        { status: 500 }
      )
    }
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
