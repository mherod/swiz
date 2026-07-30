/**
 * Status line snapshot & compliance route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { join } from "node:path"
import { stderrLog } from "../../debug.ts"
import { complianceBaselineWantedLevel } from "../../infractions.ts"
import { findTaskStoreForSession } from "../../task-roots.ts"
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

async function resolveTaskCountsFromCache(
  sessionId: string | null | undefined,
  cache: ComplianceRoutesContext["taskStateCache"]
): Promise<TaskCounts | null> {
  if (!sessionId) return null
  try {
    const { tasksDir } = findTaskStoreForSession(sessionId)
    const state = await cache.getState(sessionId, join(tasksDir, sessionId))
    stderrLog(
      "daemon task cache diagnostics",
      `[resolveTaskCountsFromCache] session=${sessionId.slice(0, 8)} tasks=${state.tasks.length} pending=${state.pendingCount} inProgress=${state.inProgressCount} ids=${state.tasks.map((t) => t.id).join(",")}`
    )
    if (state.tasks.length === 0) return null
    return buildTaskCountsFromTasks(state.tasks)
  } catch (err) {
    stderrLog("daemon task cache error", `[resolveTaskCountsFromCache] error: ${err}`)
    return null
  }
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
    resolveTaskCountsFromCache(sessionId, ctx.taskStateCache),
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
  const at = typeof body.at === "number" ? body.at : Date.now()
  const taskDurations = Array.isArray(body.taskDurations) ? body.taskDurations : undefined
  const existing = ctx.sessionComplianceState.get(body.sessionId)
  const transitioned = existing?.current?.state !== body.state
  if (transitioned) {
    const transitions = existing?.transitions ?? []
    const entry = { state: body.state, at, taskDurations }
    transitions.push(entry)
    ctx.sessionComplianceState.set(body.sessionId, { current: entry, transitions })
  } else if (existing?.current && taskDurations) {
    // Refresh task durations on the current entry without resetting `at`.
    existing.current.taskDurations = taskDurations
  }
  return Response.json({ transitioned })
}

export function handleComplianceCurrent(url: URL, ctx: ComplianceRoutesContext): Response {
  const sessionId = url.searchParams.get("sessionId")
  if (!sessionId) {
    return Response.json({ error: "Missing required query param: sessionId" }, { status: 400 })
  }
  const entry = ctx.sessionComplianceState.get(sessionId)
  return Response.json({ current: entry?.current ?? null })
}
