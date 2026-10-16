import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { DeadlineStore } from "../../deadlines/store.ts"
import { manageFileOwnership } from "../../file-ownership-tool.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import { annotateSessionsWithLiveness, type SessionRoutesContext } from "./session-routes.ts"
import { handleWorkActionRoutes } from "./work-action-routes.ts"

export async function readProjectDeadlines(
  cwd: string
): Promise<ReturnType<DeadlineStore["listProject"]>> {
  const store = await DeadlineStore.open()
  if (!store) return []
  try {
    return store.listProject(cwd)
  } finally {
    store.close()
  }
}

const defaultReaders = {
  deadlines: readProjectDeadlines,
  ownership: async (cwd: string) => manageFileOwnership({ action: "list" }, cwd),
}

/** Keep failed sources explicit: an unavailable store is not an empty project. */
async function readSection<T>(
  name: string,
  read: () => Promise<T>,
  errors: Record<string, string>
): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : `Unable to load ${name}`
    return null
  }
}

async function projectWork(
  req: Request,
  ctx: SessionRoutesContext,
  readers: typeof defaultReaders
): Promise<Response> {
  const body = await req.json().catch(() => null)
  if (typeof body?.cwd !== "string" || !isAbsolute(body.cwd) || body.cwd.includes("\0")) {
    return Response.json({ error: "cwd must be an absolute project directory" }, { status: 400 })
  }
  const directory = await stat(body.cwd).catch(() => null)
  if (!directory?.isDirectory()) {
    return Response.json({ error: "Project directory not found" }, { status: 400 })
  }
  const cwd = await registerProjectAndTouch(ctx, body.cwd)
  if (!cwd || cwd === "/") {
    return Response.json({ error: "A project directory is required" }, { status: 400 })
  }
  const errors: Record<string, string> = {}
  const [tasks, sessions, deadlines, ownership] = await Promise.all([
    readSection("tasks", () => ctx.getProjectTasks(cwd, 300), errors),
    readSection(
      "sessions",
      async () => {
        const data = await ctx.listProjectSessions(cwd, 60)
        const snapshot = await readSection("processes", ctx.getAgentProcessSnapshot, errors)
        return {
          ...data,
          processStatusAvailable: snapshot !== null,
          sessions: annotateSessionsWithLiveness(
            data.sessions,
            cwd,
            snapshot ?? { providers: {}, pidCwds: {} }
          ),
        }
      },
      errors
    ),
    readSection("deadlines", () => readers.deadlines(cwd), errors),
    readSection("ownership", () => readers.ownership(cwd), errors),
  ])
  return Response.json({
    cwd,
    generatedAt: Date.now(),
    tasks,
    sessions,
    deadlines,
    ownership,
    errors,
  })
}

export async function handleWorkRoutes(
  req: Request,
  url: URL,
  ctx: SessionRoutesContext,
  readers = defaultReaders
): Promise<Response | null> {
  const action = await handleWorkActionRoutes(req, url, ctx)
  if (action) return action
  if (url.pathname === "/work/projects" && req.method === "GET") {
    const projects = [...new Set(ctx.getKnownProjects())]
      .filter((cwd) => isAbsolute(cwd) && cwd !== "/")
      .map((cwd) => ({
        cwd,
        name: cwd.split("/").at(-1) ?? cwd,
        lastSeenAt: ctx.getProjectLastSeen(cwd),
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.cwd.localeCompare(b.cwd))
    return Response.json({ projects })
  }
  if (url.pathname !== "/projects/work" || req.method !== "POST") return null
  try {
    return await projectWork(req, ctx, readers)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load project work" },
      { status: 500 }
    )
  }
}
