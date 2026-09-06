import { useEffect, useRef } from "react"
import type { ActiveHookDispatch } from "../../commands/daemon/types.ts"
import type {
  ProjectSessions,
  ProjectTask,
  SessionMessage,
  SessionTask,
  SessionTaskSummary,
  ToolStat,
} from "../components/session-browser.tsx"
import { getQueryParam, msgKey, toSortedEvents } from "./dashboard-helpers.ts"
import type { ActiveView } from "./dashboard-state.ts"
import { fetchJson, postJson } from "./http.ts"
import { startVisiblePolling } from "./polling.ts"

export type { ActiveHookDispatch } from "../../commands/daemon/types.ts"
export { createSingleFlight } from "./polling.ts"

export interface MetricsResponse {
  uptimeMs?: number
  uptimeHuman?: string
  totalDispatches?: number
  byEvent?: Record<
    string,
    {
      count?: number
      avgMs?: number
      routes?: Record<string, { count?: number; stages?: Record<string, { avgMs?: number }> }>
    }
  >
  transcriptMonitor?: { count?: number; avgMs?: number; p95Ms?: number }
}

export interface SessionTokenStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  outputTokensPerMinute: number
}

export const SESSION_MESSAGE_LIMIT = 150

export interface WatchesResponse {
  active?: unknown[]
}

export interface AgentProcessesResponse {
  providers?: Record<string, number[]>
}

function applyFulfilled<T>(result: PromiseSettledResult<T>, apply: (value: T) => void): void {
  if (result.status === "fulfilled") apply(result.value)
}

function isSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Compare decoded JSON without allocating a second copy of transcript text. */
function equalSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!isSnapshotObject(left) || !isSnapshotObject(right)) return false
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalSnapshot(value, right[index]))
    )
  }
  if (Array.isArray(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalSnapshot(left[key], right[key]))
  )
}

/** Retain the last applied value on equal polls. Create holders per selection. */
export function snapshotChanged<T>(next: T, holder: { current: T | undefined }): boolean {
  if (equalSnapshot(next, holder.current)) return false
  holder.current = next
  return true
}

/**
 * Constant-time content-change detection from the server's opaque transcript revision.
 *
 * `equalSnapshot` avoids allocating a copy of the transcript, but still walks every message, key,
 * and nested tool argument on each poll — work proportional to the whole retained viewport just
 * to learn that nothing changed. One string comparison replaces that walk.
 *
 * Returns undefined when the response carried no revision (an older daemon, or a session that
 * could not be resolved). The caller must then fall back to structural comparison; treating a
 * missing revision as "unchanged" would freeze the transcript.
 */
export function revisionChanged(
  next: string | undefined,
  holder: { current: string | undefined }
): boolean | undefined {
  if (next === undefined) return undefined
  if (holder.current === next) return false
  holder.current = next
  return true
}

function settledError(results: PromiseSettledResult<unknown>[]): string {
  const failure = results.find((result) => result.status === "rejected")
  if (!failure || failure.status !== "rejected") return ""
  return failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
}

interface InitialSelectionDeps {
  projects: ProjectSessions[]
  selectSession: (cwd: string, sessionId: string) => void
  selectProjectOnly: (cwd: string) => void
}

export function applyInitialSelection(deps: InitialSelectionDeps): void {
  if (deps.projects.length === 0) return
  const paramProject = getQueryParam("project")
  const paramSession = getQueryParam("session")
  if (paramProject && paramSession) {
    const match = deps.projects.find((project) => project.cwd === paramProject)
    if (match) {
      deps.selectSession(paramProject, paramSession)
      return
    }
  }

  const newest = [...deps.projects].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
  if (!newest) return
  const newestSession = [...newest.sessions].sort((a, b) => b.mtime - a.mtime)[0]
  if (newestSession) {
    deps.selectSession(newest.cwd, newestSession.id)
    return
  }
  deps.selectProjectOnly(newest.cwd)
}

interface OverviewPollingDeps {
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onMetrics: (metrics: MetricsResponse) => void
  onUptime: (uptime: string) => void
  onCacheStatus: (status: Record<string, number>) => void
  onWatches: (watches: WatchesResponse) => void
  onProjects: (projects: ProjectSessions[]) => void
  onAgentProcesses: (providers: Record<string, number[]>) => void
  onActiveDispatches: (dispatches: ActiveHookDispatch[]) => void
  onError: (message: string) => void
  onLastUpdated: (time: string) => void
  onInitialLoad: (projects: ProjectSessions[]) => void
}

export function useDashboardOverviewPolling(deps: OverviewPollingDeps): void {
  const initialLoadDone = useRef(false)
  const depsRef = useRef(deps)
  depsRef.current = deps
  const { selectedProjectCwd, selectedSessionId } = deps

  useEffect(() => {
    const snapshots = {
      metrics: { current: undefined as MetricsResponse | undefined },
      watches: { current: undefined as WatchesResponse | undefined },
      projects: { current: undefined as ProjectSessions[] | undefined },
      agents: { current: undefined as Record<string, number[]> | undefined },
      dispatches: { current: undefined as ActiveHookDispatch[] | undefined },
      cache: { current: undefined as Record<string, number> | undefined },
      error: { current: "" },
    }
    const applyError = (message: string) => {
      if (snapshotChanged(message, snapshots.error)) depsRef.current.onError(message)
    }
    async function fetchAllData(signal: AbortSignal) {
      const project = selectedProjectCwd
      const session = selectedSessionId
      const [m, cs, w, pr, ap, ad] = await Promise.allSettled([
        fetchJson<MetricsResponse>("/metrics", signal),
        fetchJson<Record<string, number>>("/cache/status", signal),
        fetchJson<WatchesResponse>("/ci-watches", signal),
        postJson<{ projects: ProjectSessions[] }>(
          "/sessions/projects",
          {
            limitProjects: 10,
            limitSessionsPerProject: 10,
            selectedProjectCwd: project,
            selectedSessionId: session,
          },
          signal
        ),
        fetchJson<AgentProcessesResponse>("/process/agents", signal),
        fetchJson<{ active?: ActiveHookDispatch[] }>(
          `/dispatch/active?cwd=${encodeURIComponent(project ?? "")}&sessionId=${encodeURIComponent(session ?? "")}`,
          signal
        ),
      ])
      return { m, cs, w, pr, ap, ad }
    }

    function applyUpdates(data: Awaited<ReturnType<typeof fetchAllData>>) {
      const { m, cs, w, pr, ap, ad } = data
      const currentDeps = depsRef.current
      const applyIfChanged = <T>(
        value: T,
        holder: { current: T | undefined },
        apply: (value: T) => void
      ): void => {
        if (snapshotChanged(value, holder)) apply(value)
      }
      applyFulfilled(m, (value) => {
        currentDeps.onUptime(value.uptimeHuman ?? "starting")
        const metrics = { ...value }
        delete metrics.uptimeHuman
        delete metrics.uptimeMs
        applyIfChanged(metrics, snapshots.metrics, currentDeps.onMetrics)
      })
      applyFulfilled(cs, (value) =>
        applyIfChanged(value, snapshots.cache, currentDeps.onCacheStatus)
      )
      applyFulfilled(w, (value) => applyIfChanged(value, snapshots.watches, currentDeps.onWatches))
      applyFulfilled(pr, (value) =>
        applyIfChanged(value.projects ?? [], snapshots.projects, currentDeps.onProjects)
      )
      applyFulfilled(ap, (value) =>
        applyIfChanged(value.providers ?? {}, snapshots.agents, currentDeps.onAgentProcesses)
      )
      applyFulfilled(ad, (value) =>
        applyIfChanged(value.active ?? [], snapshots.dispatches, currentDeps.onActiveDispatches)
      )
      applyError(settledError([m, cs, w, pr, ap, ad]))
      currentDeps.onLastUpdated(new Date().toISOString())

      if (!initialLoadDone.current && pr.status === "fulfilled") {
        initialLoadDone.current = true
        currentDeps.onInitialLoad(pr.value.projects ?? [])
      }
    }

    return startVisiblePolling(async (signal) => {
      try {
        const data = await fetchAllData(signal)
        if (signal.aborted) return
        applyUpdates(data)
      } catch (err) {
        if (!signal.aborted)
          applyError(err instanceof Error ? err.message : "Unknown fetch failure")
      }
    }, 5000).stop
  }, [selectedProjectCwd, selectedSessionId])
}

export function useProjectMetricsPolling(
  selectedProjectCwd: string | null,
  enabled: boolean,
  setProjectEvents: (events: Array<{ name: string; count: number; avgMs: number }>) => void,
  setProjectMonitor: (metric: MetricsResponse["transcriptMonitor"] | null) => void
): void {
  useEffect(() => {
    if (!selectedProjectCwd || !enabled) {
      setProjectEvents([])
      setProjectMonitor(null)
      return
    }
    const cwd = selectedProjectCwd
    const events = {
      current: undefined as Array<{ name: string; count: number; avgMs: number }> | undefined,
    }
    const monitor = { current: undefined as MetricsResponse["transcriptMonitor"] | null }
    return startVisiblePolling(async (signal) => {
      try {
        const pm = await fetchJson<MetricsResponse>(
          `/metrics?project=${encodeURIComponent(cwd)}`,
          signal
        )
        if (signal.aborted) return
        const nextEvents = toSortedEvents(pm.byEvent)
        const nextMonitor = pm.transcriptMonitor ?? null
        if (snapshotChanged(nextEvents, events)) setProjectEvents(nextEvents)
        if (snapshotChanged(nextMonitor, monitor)) setProjectMonitor(nextMonitor)
      } catch {
        if (signal.aborted) return
        if (snapshotChanged([], events)) setProjectEvents([])
        if (snapshotChanged(null, monitor)) setProjectMonitor(null)
      }
    }, 5000).stop
  }, [selectedProjectCwd, enabled, setProjectEvents, setProjectMonitor])
}

interface SessionPollingDeps {
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  activeView: ActiveView
  refreshVersion: number
  onLoading: (messages: boolean, tasks: boolean, projectTasks: boolean) => void
  onMessages: (
    messages: SessionMessage[],
    toolStats: ToolStat[],
    tokenStats?: SessionTokenStats
  ) => void
  onTasks: (tasks: SessionTask[], summary: SessionTaskSummary | null) => void
  onProjectTasks: (tasks: ProjectTask[], summary: SessionTaskSummary | null) => void
  onNewMessageKeys: (keys: Set<string>) => void
}

function computeFreshMessageKeys(messages: SessionMessage[], knownKeys: Set<string>): Set<string> {
  const fresh = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const key = msgKey(messages[i]!, i)
    if (!knownKeys.has(key)) fresh.add(key)
  }
  return fresh
}

function fetchSessionSnapshots(
  cwd: string,
  sessionId: string | null,
  enabled: { messages: boolean; tasks: boolean; projectTasks: boolean },
  signal: AbortSignal
) {
  return Promise.allSettled([
    enabled.messages
      ? postJson<{
          messages: SessionMessage[]
          toolStats?: ToolStat[]
          tokenStats?: SessionTokenStats
          revision?: string
        }>("/sessions/messages", { cwd, sessionId, limit: SESSION_MESSAGE_LIMIT }, signal)
      : Promise.resolve(null),
    enabled.tasks
      ? postJson<{ tasks: SessionTask[]; summary?: SessionTaskSummary }>(
          "/sessions/tasks",
          { cwd, sessionId, limit: 20 },
          signal
        )
      : Promise.resolve(null),
    enabled.projectTasks
      ? postJson<{ tasks: ProjectTask[]; summary?: SessionTaskSummary }>(
          "/projects/tasks",
          { cwd, limit: 80 },
          signal
        )
      : Promise.resolve(null),
  ])
}

export function useSessionPolling(deps: SessionPollingDeps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const selectedProjectCwd = deps.selectedProjectCwd
  const selectedSessionId = deps.selectedSessionId
  const { activeView, refreshVersion } = deps

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh of the same selection restarts its cancellable flight.
  useEffect(() => {
    const pollMessages =
      !!selectedSessionId && (activeView === "dashboard" || activeView === "transcript")
    const pollProjectTasks = activeView === "dashboard" || activeView === "tasks"
    const pollTasks = !!selectedSessionId && pollProjectTasks
    if (!selectedProjectCwd || (!pollMessages && !pollProjectTasks)) return
    const cwd = selectedProjectCwd
    const sid = selectedSessionId

    let initialLoad = true
    let knownKeys = new Set<string>()
    let clearFreshKeys: ReturnType<typeof setTimeout> | undefined
    const messagesSnapshot = { current: undefined as SessionMessage[] | undefined }
    const revisionSnapshot = { current: undefined as string | undefined }
    const toolsSnapshot = { current: undefined as ToolStat[] | undefined }
    const tokensSnapshot = { current: undefined as SessionTokenStats | undefined }
    const tasksSnapshot = { current: undefined as unknown }
    const projectTasksSnapshot = { current: undefined as unknown }

    function handleMessagesUpdate(
      msgs: SessionMessage[],
      toolStats: ToolStat[] | undefined,
      fresh: Set<string>,
      tokenStats: SessionTokenStats | undefined
    ): void {
      const currentDeps = depsRef.current
      currentDeps.onNewMessageKeys(fresh)
      currentDeps.onMessages(msgs, toolStats ?? [], tokenStats)
      if (fresh.size > 0) {
        if (clearFreshKeys) clearTimeout(clearFreshKeys)
        clearFreshKeys = setTimeout(() => {
          depsRef.current.onNewMessageKeys(new Set())
        }, 500)
      }
    }

    function applyMessages(value: {
      messages: SessionMessage[]
      toolStats?: ToolStat[]
      tokenStats?: SessionTokenStats
      revision?: string
    }): void {
      const msgs = value.messages ?? []
      // Prefer the server revision: one string comparison instead of walking the viewport.
      const byRevision = revisionChanged(value.revision, revisionSnapshot)
      const messagesChanged =
        byRevision === undefined ? snapshotChanged(msgs, messagesSnapshot) : byRevision
      // Tool and token telemetry change independently of message content and must stay fresh
      // even when the revision says the transcript is unchanged.
      const toolsChanged = snapshotChanged(value.toolStats ?? [], toolsSnapshot)
      const tokensChanged = snapshotChanged(value.tokenStats, tokensSnapshot)
      // On the revision path `snapshotChanged` never ran, so the holder is synced here. An
      // unchanged revision leaves it alone, retaining the previous array identity.
      if (byRevision === true) messagesSnapshot.current = msgs
      if (messagesChanged) {
        const fresh = computeFreshMessageKeys(msgs, knownKeys)
        knownKeys = new Set(msgs.map(msgKey))
        handleMessagesUpdate(msgs, toolsSnapshot.current, fresh, tokensSnapshot.current)
      } else if (toolsChanged || tokensChanged) {
        depsRef.current.onMessages(
          messagesSnapshot.current ?? [],
          toolsSnapshot.current ?? [],
          tokensSnapshot.current
        )
      }
    }

    const polling = startVisiblePolling(async (signal) => {
      if (initialLoad) depsRef.current.onLoading(pollMessages, pollTasks, pollProjectTasks)
      try {
        const [messagesResult, tasksResult, projectTasksResult] = await fetchSessionSnapshots(
          cwd,
          sid,
          { messages: pollMessages, tasks: pollTasks, projectTasks: pollProjectTasks },
          signal
        )

        if (signal.aborted) return

        applyFulfilled(messagesResult, (value) => {
          if (value) applyMessages(value)
        })

        // Messages have been snapshot-guarded for a while; tasks were not, so every 2s
        // tick handed React new array identities for unchanged content and churned the
        // root state the whole dashboard hangs off (#856).
        const currentDeps = depsRef.current
        applyFulfilled(tasksResult, (value) => {
          if (!value) return
          const tasks = value.tasks ?? []
          const summary = value.summary ?? null
          if (!snapshotChanged([tasks, summary], tasksSnapshot)) return
          currentDeps.onTasks(tasks, summary)
        })
        applyFulfilled(projectTasksResult, (value) => {
          if (!value) return
          const tasks = value.tasks ?? []
          const summary = value.summary ?? null
          if (!snapshotChanged([tasks, summary], projectTasksSnapshot)) return
          currentDeps.onProjectTasks(tasks, summary)
        })
      } catch {
        // ignore polling errors
      } finally {
        if (initialLoad && !signal.aborted) {
          initialLoad = false
          depsRef.current.onLoading(false, false, false)
        }
      }
    }, 2000)
    return () => {
      polling.stop()
      if (clearFreshKeys) clearTimeout(clearFreshKeys)
      depsRef.current.onLoading(false, false, false)
    }
  }, [selectedProjectCwd, selectedSessionId, activeView, refreshVersion])
}
