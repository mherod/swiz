/**
 * Status line snapshot & compliance route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { join } from "node:path"
import { stderrLog } from "../../debug.ts"
import { complianceBaselineWantedLevel } from "../../infractions.ts"
import { projectKeyFromCwd } from "../../project-key.ts"
import { findTaskStoreForSession } from "../../task-roots.ts"
import { mergeTaskStoresByRecency, readTasks } from "../../tasks/task-repository.ts"
import type { TaskCounts, WarmStatusLineSnapshot } from "../status-line.ts"
import { buildTaskCountsFromTasks } from "../status-line.ts"
import type { CappedMap } from "./cache/capped-map.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"

type ComplianceEntry = {
  state: string
  at: number
  taskDurations?: Array<{ id: string; status: string; durationMs: number }>
}

type SessionComplianceState = CappedMap<
  string,
  {
    current: ComplianceEntry | null
    transitions: ComplianceEntry[]
  }
>

export interface ComplianceRoutesContext {
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  sessionComplianceState: SessionComplianceState
  upstreamSyncRegistry: UpstreamSyncRegistry
}

const STALE_SYNC_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Warm task counts for the status line, unioned across both store keys.
 *
 * The MCP task tools key the store by `projectKeyFromCwd(cwd)` while the native tools key it by
 * session id, so reading only the session directory reports an empty queue for any session driven
 * through MCP. The session store is served warm from the cache; the project store is read from disk
 * (see below) and the two lists merged by recency — the same union the governance hook already does.
 */
async function resolveTaskCountsFromCache(
  sessionId: string | null | undefined,
  cwd: string,
  cache: ComplianceRoutesContext["taskStateCache"]
): Promise<TaskCounts | null> {
  if (!sessionId) return null
  try {
    const { tasksDir } = findTaskStoreForSession(sessionId)
    const projectKey = projectKeyFromCwd(cwd)
    const sessionState = await cache.getState(sessionId, join(tasksDir, sessionId))
    const projectTasks =
      projectKey && projectKey !== sessionId
        ? await readProjectStoreTasks(projectKey, tasksDir)
        : []
    const tasks = mergeTaskStoresByRecency(sessionState.tasks, projectTasks)
    stderrLog(
      "daemon task cache diagnostics",
      `[resolveTaskCountsFromCache] session=${sessionId.slice(0, 8)} tasks=${tasks.length} session=${sessionState.tasks.length} project=${projectTasks.length} ids=${tasks.map((t) => t.id).join(",")}`
    )
    if (tasks.length === 0) return null
    return buildTaskCountsFromTasks(tasks)
  } catch (err) {
    stderrLog("daemon task cache error", `[resolveTaskCountsFromCache] error: ${err}`)
    return null
  }
}

/**
 * Read the project-keyed store straight from disk, never through `TaskStateCache`.
 *
 * A cache load runs `pruneStaleCompleted`, which `unlink`s completed task files older than
 * `COMPLETED_TASK_PRUNE_AGE_MS`. That is sound for the session store the daemon owns and destructive
 * for the long-lived project store, which accumulates history across sessions — pointing the cache
 * at it made rendering the status line delete the tasks it was counting.
 */
async function readProjectStoreTasks(
  projectKey: string,
  tasksDir: string
): Promise<Array<{ id: string; status: string; statusChangedAt?: string }>> {
  return readTasks(projectKey, tasksDir).catch(() => [])
}

export function resolveComplianceDurationLabel(
  sessionId: string,
  store: SessionComplianceState
): string | null {
  const entry = store.get(sessionId)
  if (!entry?.current) return null
  const ms = Date.now() - entry.current.at
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

export function resolveComplianceDurationSeconds(
  sessionId: string,
  store: SessionComplianceState
): number | null {
  const entry = store.get(sessionId)
  if (!entry?.current) return null
  return Math.floor((Date.now() - entry.current.at) / 1000)
}

export async function handleStatusLineSnapshot(
  req: Request,
  ctx: ComplianceRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    sessionId?: string | null
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  const sessionId = body?.sessionId ?? null
  const [snapshot, taskCounts] = await Promise.all([
    ctx.resolveSnapshot(body.cwd, sessionId),
    resolveTaskCountsFromCache(sessionId, body.cwd, ctx.taskStateCache),
  ])
  const complianceDurationLabel = sessionId
    ? resolveComplianceDurationLabel(sessionId, ctx.sessionComplianceState)
    : null
  const complianceDurationSeconds = sessionId
    ? resolveComplianceDurationSeconds(sessionId, ctx.sessionComplianceState)
    : null
  // Match on canonical project root, not raw string equality — the status line
  // reports from whatever cwd the session is in, which is often a subdirectory
  // of the registered repo root (#717).
  const syncEntry = ctx.upstreamSyncRegistry.findActiveForCwd(body.cwd)
  const issueSyncStale = syncEntry
    ? syncEntry.lastSyncAt === null || Date.now() - syncEntry.lastSyncAt > STALE_SYNC_THRESHOLD_MS
    : null
  // Compliance-derived baseline of the GTA wanted level, surfaced from the daemon
  // so any consumer (status line, future web view) reads a warm value. Retry-after-block
  // infractions are layered on top client-side by the status line.
  const wantedLevel = complianceBaselineWantedLevel(taskCounts)
  return Response.json({
    snapshot: {
      ...snapshot,
      taskCounts,
      complianceDurationLabel,
      complianceDurationSeconds,
      wantedLevel,
      issueSyncStale,
    },
  })
}

export async function handleComplianceRecord(
  req: Request,
  ctx: ComplianceRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    sessionId?: string
    state?: string
    at?: number
    taskDurations?: Array<{ id: string; status: string; durationMs: number }>
  } | null
  if (typeof body?.sessionId !== "string" || !body.sessionId || typeof body?.state !== "string") {
    return Response.json({ error: "Missing required fields: sessionId, state" }, { status: 400 })
  }
  const transitioned = recordComplianceState(
    { ...body, sessionId: body.sessionId, state: body.state },
    ctx.sessionComplianceState
  )
  return Response.json({ transitioned })
}

function recordComplianceState(
  body: {
    sessionId: string
    state: string
    at?: number
    taskDurations?: Array<{ id: string; status: string; durationMs: number }>
  },
  store: SessionComplianceState
): boolean {
  const at = typeof body.at === "number" ? body.at : Date.now()
  const taskDurations = Array.isArray(body.taskDurations) ? body.taskDurations : undefined
  const existing = store.get(body.sessionId)
  const transitioned = existing?.current?.state !== body.state
  if (!transitioned) return refreshComplianceDurations(existing?.current ?? null, taskDurations)

  const transitions = existing?.transitions ?? []
  const entry = { state: body.state, at, taskDurations }
  transitions.push(entry)
  store.set(body.sessionId, { current: entry, transitions })
  return true
}

function refreshComplianceDurations(
  current: ComplianceEntry | null,
  taskDurations: ComplianceEntry["taskDurations"]
): false {
  if (current && taskDurations) current.taskDurations = taskDurations
  return false
}

export function handleComplianceCurrent(url: URL, ctx: ComplianceRoutesContext): Response {
  const sessionId = url.searchParams.get("sessionId")
  if (!sessionId) {
    return Response.json({ error: "Missing required query param: sessionId" }, { status: 400 })
  }
  const entry = ctx.sessionComplianceState.get(sessionId)
  return Response.json({ current: entry?.current ?? null })
}
