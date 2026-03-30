import type { SessionPreview } from "./session-data.ts"
import type { SessionMessage, SessionTaskSummary } from "./types.ts"
import type { ProjectTaskPreview, SessionTaskPreview } from "./utils.ts"

export interface AgentProcessSnapshot {
  providers: Record<string, number[]>
  pidCwds: Record<number, string>
}

/** `listProjectSessions` payload exposed through session HTTP routes */
export interface SessionRoutesListResult {
  sessionCount: number
  sessions: SessionPreview[]
}

/** `getSessionData` payload exposed through session HTTP routes */
export interface SessionRoutesMessagesResult {
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
}

/** `getSessionTasks` payload exposed through session HTTP routes */
export interface SessionRoutesSessionTasksResult {
  tasks: SessionTaskPreview[]
  summary: SessionTaskSummary
}

/** `getProjectTasks` payload exposed through session HTTP routes */
export interface SessionRoutesProjectTasksResult {
  tasks: ProjectTaskPreview[]
  summary: SessionTaskSummary
}

/** Session row after liveness annotation for the projects list response */
export type SessionWithLiveness = SessionPreview & { processAlive: boolean }

export interface SessionRoutesContext {
  touchProject: (cwd: string) => void
  getKnownProjects: () => string[]
  getProjectLastSeen: (cwd: string) => number
  getProjectStatusLine: (cwd: string, sessionId?: string) => Promise<string>
  listProjectSessions: (
    cwd: string,
    limit: number,
    pinnedSessionId?: string
  ) => Promise<SessionRoutesListResult>
  getSessionData: (
    cwd: string,
    sessionId: string,
    limit: number
  ) => Promise<SessionRoutesMessagesResult>
  getSessionTasks: (sessionId: string, limit: number) => Promise<SessionRoutesSessionTasksResult>
  getProjectTasks: (cwd: string, limit: number) => Promise<SessionRoutesProjectTasksResult>
  getAgentProcessSnapshot: () => Promise<AgentProcessSnapshot>
}

/** Check if any agent process has a cwd that is within the given project directory. */
export function hasLiveAgentForProject(
  projectCwd: string,
  snapshot: AgentProcessSnapshot
): boolean {
  for (const cwd of Object.values(snapshot.pidCwds)) {
    if (cwd === projectCwd || cwd.startsWith(`${projectCwd}/`)) return true
  }
  return false
}

/** Get PIDs of agent processes whose cwd is within the given project directory. */
function getProjectAgentPids(projectCwd: string, snapshot: AgentProcessSnapshot): number[] {
  const pids: number[] = []
  for (const [pidStr, cwd] of Object.entries(snapshot.pidCwds)) {
    if (cwd === projectCwd || cwd.startsWith(`${projectCwd}/`)) {
      pids.push(Number(pidStr))
    }
  }
  return pids.sort((a, b) => a - b)
}

/** Annotate sessions with processAlive based on agent process cwds matching project cwd. */
export function annotateSessionsWithLiveness(
  sessions: SessionPreview[],
  projectCwd: string,
  snapshot: AgentProcessSnapshot
): SessionWithLiveness[] {
  const projectHasLiveAgent = hasLiveAgentForProject(projectCwd, snapshot)
  if (!projectHasLiveAgent) {
    return sessions.map((s) => ({ ...s, processAlive: false }))
  }
  const projectPids = new Set(getProjectAgentPids(projectCwd, snapshot))
  // Map provider -> whether it has a live PID in this project
  const liveProviders = new Set<string>()
  for (const [provider, pids] of Object.entries(snapshot.providers)) {
    if (pids.some((pid) => projectPids.has(pid))) liveProviders.add(provider)
  }
  return sessions.map((s) => {
    const provider = (s.provider ?? "unknown").toLowerCase()
    return { ...s, processAlive: liveProviders.has(provider) }
  })
}

function parseProjectsListBody(raw: Record<string, unknown> | null) {
  if (!raw) return null
  return {
    limitProjects:
      (raw.limitProjects as number | undefined) ??
      (raw.limits as { projects?: number } | undefined)?.projects,
    limitSessionsPerProject: raw.limitSessionsPerProject as number | undefined,
    selectedProjectCwd:
      (raw.selectedProjectCwd as string | undefined) ?? (raw.selectedProject as string | undefined),
    selectedSessionId:
      (raw.selectedSessionId as string | undefined) ?? (raw.selectedSession as string | undefined),
  }
}

async function handleProjectsList(req: Request, ctx: SessionRoutesContext): Promise<Response> {
  try {
    const rawBody = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const body = parseProjectsListBody(rawBody)

    const limitProjects = Math.max(1, Math.min(30, body?.limitProjects ?? 8))
    const limitSessions = Math.max(1, Math.min(30, body?.limitSessionsPerProject ?? 8))
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
          const sessions = await ctx.listProjectSessions(cwd, limitSessions, pinnedSessionId)
          const firstSession = sessions.sessions[0]
          const statusLine = await ctx.getProjectStatusLine(
            cwd,
            pinnedSessionId ?? firstSession?.id
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

async function handleSessionMessages(req: Request, ctx: SessionRoutesContext): Promise<Response> {
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

async function handleSessionTasks(req: Request, ctx: SessionRoutesContext): Promise<Response> {
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

async function handleProjectTasks(req: Request, ctx: SessionRoutesContext): Promise<Response> {
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

interface CreateTaskBody {
  sessionId?: string
  subject?: string
  description?: string
  cwd?: string
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.length > 0
}

function parseCreateTaskBody(
  body: CreateTaskBody | null
): { sessionId: string; subject: string; description: string; cwd?: string } | null {
  if (!body) return null
  const sessionId = body.sessionId
  const subject = (body.subject ?? "").trim()
  if (!isNonEmptyString(sessionId) || !subject) return null
  const description = (body.description ?? "").trim() || subject
  const cwd = isNonEmptyString(body.cwd) ? body.cwd : undefined
  return { sessionId, subject, description, cwd }
}

async function handleCreateTask(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as CreateTaskBody | null
  const parsed = parseCreateTaskBody(body)
  if (!parsed) {
    return Response.json(
      { error: "Missing required fields: sessionId (string), subject (string)" },
      { status: 400 }
    )
  }
  try {
    const { createTaskInProcess } = await import("../../tasks/task-service.ts")
    const task = await createTaskInProcess(parsed)
    return Response.json({ task })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create task" },
      { status: 500 }
    )
  }
}

type RouteHandler = (req: Request, ctx: SessionRoutesContext) => Promise<Response>

const SESSION_ROUTES: Array<{ path: string; method: string; handler: RouteHandler }> = [
  { path: "/sessions/projects", method: "POST", handler: handleProjectsList },
  { path: "/sessions/messages", method: "POST", handler: handleSessionMessages },
  { path: "/sessions/tasks", method: "POST", handler: handleSessionTasks },
  { path: "/projects/tasks", method: "POST", handler: handleProjectTasks },
  { path: "/tasks/create", method: "POST", handler: (req) => handleCreateTask(req) },
]

export async function handleSessionRoutes(
  req: Request,
  url: URL,
  ctx: SessionRoutesContext
): Promise<Response | null> {
  const route = SESSION_ROUTES.find((r) => r.path === url.pathname && r.method === req.method)
  return route ? route.handler(req, ctx) : null
}
