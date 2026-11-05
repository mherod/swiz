import { UNSEEN_SESSION_TASK_CANCEL_AGE_MS } from "../../tasks/task-governance-constants.ts"
import {
  type CancelledTaskRef,
  cancelTasksOfUnseenSessions,
  type SessionSightingLookup,
} from "../../tasks/unseen-session-task-cancel.ts"
import { findAllProviderSessions } from "../../transcript-sessions.ts"

export const UNSEEN_SESSION_SWEEP_INTERVAL_MS = 15 * 60_000
const INITIAL_SWEEP_DELAY_MS = 60_000

type FindSessions = (
  cwd: string,
  modifiedSinceMs: number
) => Promise<ReadonlyArray<{ id: string; mtime: number }>>

export interface UnseenSessionSweepDeps {
  /** Daemon's in-memory last dispatch time for a session, if it has one. */
  liveLastSeenMs: (sessionId: string) => number | undefined
  findSessions?: FindSessions
  tasksDir?: string
  maxAgeMs?: number
  now?: () => number
  onCancelled?: (cancelled: CancelledTaskRef[]) => void
}

const defaultFindSessions: FindSessions = (cwd, modifiedSinceMs) =>
  findAllProviderSessions(cwd, undefined, undefined, modifiedSinceMs)

/**
 * Sighting lookup for one sweep: the daemon's live activity, else the session's
 * transcript mtime. Transcripts are listed once per project per sweep, limited
 * to ones modified inside the window, so a hit alone proves a recent sighting.
 */
export function createSessionSightingLookup(
  liveLastSeenMs: (sessionId: string) => number | undefined,
  cutoffMs: number,
  findSessions: FindSessions = defaultFindSessions
): SessionSightingLookup {
  const byProject = new Map<string, Promise<Map<string, number>>>()
  const recentSessions = (cwd: string) => {
    let cached = byProject.get(cwd)
    if (!cached) {
      cached = findSessions(cwd, cutoffMs).then(
        (sessions) => new Map(sessions.map((session) => [session.id, session.mtime]))
      )
      byProject.set(cwd, cached)
    }
    return cached
  }
  return async (sessionId, cwd) => {
    const live = liveLastSeenMs(sessionId)
    if (live !== undefined && live >= cutoffMs) return live
    const transcriptMs = cwd ? (await recentSessions(cwd)).get(sessionId) : undefined
    const known = [live, transcriptMs].filter((ms): ms is number => ms !== undefined)
    return known.length > 0 ? Math.max(...known) : null
  }
}

/** One sweep over every per-session task store. */
export async function sweepUnseenSessionTasks(
  deps: UnseenSessionSweepDeps
): Promise<CancelledTaskRef[]> {
  const nowMs = (deps.now ?? Date.now)()
  const maxAgeMs = deps.maxAgeMs ?? UNSEEN_SESSION_TASK_CANCEL_AGE_MS
  const cancelled = await cancelTasksOfUnseenSessions({
    tasksDir: deps.tasksDir,
    nowMs,
    maxAgeMs,
    sessionLastSeenMs: createSessionSightingLookup(
      deps.liveLastSeenMs,
      nowMs - maxAgeMs,
      deps.findSessions
    ),
  })
  if (cancelled.length > 0) deps.onCancelled?.(cancelled)
  return cancelled
}

/** Run the sweep periodically; overlapping ticks are skipped. */
export function startUnseenSessionTaskSweep(
  deps: UnseenSessionSweepDeps,
  intervalMs = UNSEEN_SESSION_SWEEP_INTERVAL_MS,
  onError: (error: unknown) => void = () => {}
): { tick(): Promise<void>; stop(): void } {
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await sweepUnseenSessionTasks(deps)
    } catch (error) {
      if (!stopped) onError(error)
    } finally {
      running = false
    }
  }
  // Daemon restarts are routine; an early first tick keeps them from starving the sweep.
  const initial = setTimeout(() => void tick(), Math.min(INITIAL_SWEEP_DELAY_MS, intervalMs))
  initial.unref()
  const interval = setInterval(() => void tick(), intervalMs)
  interval.unref()
  return {
    tick,
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    },
  }
}
