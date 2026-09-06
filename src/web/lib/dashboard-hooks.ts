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
import { fetchJson, postJson } from "./http.ts"

export type { ActiveHookDispatch } from "../../commands/daemon/types.ts"

export interface MetricsResponse {
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

/**
 * True when a polled slice's serialized content differs from the last applied one,
 * recording it as applied when so.
 *
 * A 2s poll returns equal content most ticks, and handing React a fresh array each time
 * churns the root state the whole dashboard hangs off. The holder is a `useRef` box, which
 * outlives the effect — so callers must clear it on a project or session switch, or the
 * previous selection's snapshot suppresses the new one's first update whenever the two
 * serialize alike (#856).
 */
export function snapshotChanged(next: string, holder: { current: string }): boolean {
  if (next === holder.current) return false
  holder.current = next
  return true
}

function settledError(results: PromiseSettledResult<unknown>[]): string {
  const failure = results.find((result) => result.status === "rejected")
  if (!failure || failure.status !== "rejected") return ""
  return failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
}

export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null
  return () => {
    if (active) return active
    active = task().finally(() => {
      active = null
    })
    return active
  }
}

interface InitialSelectionDeps {
  projects: ProjectSessions[]
  selectSession: (cwd: string, sessionId: string) => void
  selectProjectOnly: (cwd: string) => void
  loadProjectTasks: (cwd: string) => Promise<void>
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
  void deps.loadProjectTasks(newest.cwd)
}

interface OverviewPollingDeps {
  onMetrics: (metrics: MetricsResponse) => void
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
  const prevCoreSnapshotRef = useRef("")
  const prevCacheSnapshotRef = useRef("")
  const initialLoadDone = useRef(false)
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => {
    async function fetchAllData() {
      const project = getQueryParam("project")
      const session = getQueryParam("session")
      const [m, cs, w, pr, ap, ad] = await Promise.allSettled([
        fetchJson<MetricsResponse>("/metrics"),
        fetchJson<Record<string, number>>("/cache/status"),
        fetchJson<WatchesResponse>("/ci-watches"),
        postJson<{ projects: ProjectSessions[] }>("/sessions/projects", {
          limitProjects: 10,
          limitSessionsPerProject: 10,
          selectedProjectCwd: project,
          selectedSessionId: session,
        }),
        fetchJson<AgentProcessesResponse>("/process/agents"),
        fetchJson<{ active?: ActiveHookDispatch[] }>(
          `/dispatch/active?cwd=${encodeURIComponent(project ?? "")}&sessionId=${encodeURIComponent(session ?? "")}`
        ),
      ])
      return { m, cs, w, pr, ap, ad }
    }

    function applyUpdates(data: Awaited<ReturnType<typeof fetchAllData>>) {
      const { m, cs, w, pr, ap, ad } = data
      const coreSnapshot = JSON.stringify({ m, w, pr, ap, ad })
      const cacheSnapshot = cs.status === "fulfilled" ? JSON.stringify(cs.value) : null
      const coreChanged = coreSnapshot !== prevCoreSnapshotRef.current
      const cacheChanged = cacheSnapshot !== prevCacheSnapshotRef.current
      if (!coreChanged && !cacheChanged) return
      if (cacheChanged) {
        applyFulfilled(cs, (value) => {
          prevCacheSnapshotRef.current = JSON.stringify(value)
          depsRef.current.onCacheStatus(value)
        })
      }
      if (!coreChanged) return
      prevCoreSnapshotRef.current = coreSnapshot
      const currentDeps = depsRef.current
      applyFulfilled(m, currentDeps.onMetrics)
      applyFulfilled(w, currentDeps.onWatches)
      applyFulfilled(pr, (value) => currentDeps.onProjects(value.projects ?? []))
      applyFulfilled(ap, (value) => currentDeps.onAgentProcesses(value.providers ?? {}))
      applyFulfilled(ad, (value) => currentDeps.onActiveDispatches(value.active ?? []))
      currentDeps.onError(settledError([m, cs, w, pr, ap, ad]))
      currentDeps.onLastUpdated(new Date().toISOString())

      if (!initialLoadDone.current && pr.status === "fulfilled") {
        initialLoadDone.current = true
        currentDeps.onInitialLoad(pr.value.projects ?? [])
      }
    }

    const refresh = createSingleFlight(async () => {
      try {
        const data = await fetchAllData()
        applyUpdates(data)
      } catch (err) {
        depsRef.current.onError(err instanceof Error ? err.message : "Unknown fetch failure")
      }
    })

    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [])
}

export function useProjectMetricsPolling(
  selectedProjectCwd: string | null,
  setProjectEvents: (events: Array<{ name: string; count: number; avgMs: number }>) => void,
  setProjectMonitor: (metric: MetricsResponse["transcriptMonitor"] | null) => void
): void {
  useEffect(() => {
    if (!selectedProjectCwd) {
      setProjectEvents([])
      setProjectMonitor(null)
      return
    }
    const cwd = selectedProjectCwd
    const fetchProjectMetrics = createSingleFlight(async () => {
      try {
        const pm = await fetchJson<MetricsResponse>(`/metrics?project=${encodeURIComponent(cwd)}`)
        setProjectEvents(toSortedEvents(pm.byEvent))
        setProjectMonitor(pm.transcriptMonitor ?? null)
      } catch {
        setProjectEvents([])
        setProjectMonitor(null)
      }
    })
    void fetchProjectMetrics()
    const id = setInterval(() => void fetchProjectMetrics(), 5000)
    return () => clearInterval(id)
  }, [selectedProjectCwd, setProjectEvents, setProjectMonitor])
}

interface SessionPollingDeps {
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onMessages: (
    messages: SessionMessage[],
    toolStats: ToolStat[],
    tokenStats?: SessionTokenStats
  ) => void
  onTasks: (tasks: SessionTask[], summary: SessionTaskSummary | null) => void
  onProjectTasks: (tasks: ProjectTask[], summary: SessionTaskSummary | null) => void
  onNewMessageKeys: (keys: Set<string>) => void
}

export function useSessionPolling(deps: SessionPollingDeps): void {
  const knownKeysRef = useRef<Set<string>>(new Set())
  const messagesPrevSnapshotRef = useRef("")
  const tasksPrevSnapshotRef = useRef("")
  const projectTasksPrevSnapshotRef = useRef("")
  const depsRef = useRef(deps)
  depsRef.current = deps
  const selectedProjectCwd = deps.selectedProjectCwd
  const selectedSessionId = deps.selectedSessionId

  useEffect(() => {
    if (!selectedProjectCwd || !selectedSessionId) return
    const cwd = selectedProjectCwd
    const sid = selectedSessionId

    // These refs outlive the effect, so a switch would otherwise carry the previous
    // selection's snapshot into the new one and suppress its first update whenever the
    // two serialize alike — two empty lists being the common case (#856).
    messagesPrevSnapshotRef.current = ""
    tasksPrevSnapshotRef.current = ""
    projectTasksPrevSnapshotRef.current = ""
    knownKeysRef.current = new Set()

    function computeFreshMessageKeys(
      messages: SessionMessage[],
      knownKeys: Set<string>
    ): Set<string> {
      const fresh = new Set<string>()
      for (let i = 0; i < messages.length; i++) {
        const key = msgKey(messages[i]!, i)
        if (!knownKeys.has(key)) fresh.add(key)
      }
      return fresh
    }

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
        setTimeout(() => depsRef.current.onNewMessageKeys(new Set()), 500)
      }
    }

    const pollSessionData = createSingleFlight(async () => {
      try {
        const [messagesResult, tasksResult, projectTasksResult] = await Promise.allSettled([
          postJson<{
            messages: SessionMessage[]
            toolStats?: ToolStat[]
            tokenStats?: SessionTokenStats
          }>("/sessions/messages", {
            cwd,
            sessionId: sid,
            limit: SESSION_MESSAGE_LIMIT,
          }),
          postJson<{ tasks: SessionTask[]; summary?: SessionTaskSummary }>("/sessions/tasks", {
            cwd,
            sessionId: sid,
            limit: 20,
          }),
          postJson<{ tasks: ProjectTask[]; summary?: SessionTaskSummary }>("/projects/tasks", {
            cwd,
            limit: 80,
          }),
        ])

        if (messagesResult.status === "fulfilled") {
          const msgs = messagesResult.value.messages ?? []
          if (snapshotChanged(JSON.stringify(msgs), messagesPrevSnapshotRef)) {
            const fresh = computeFreshMessageKeys(msgs, knownKeysRef.current)
            knownKeysRef.current = new Set(msgs.map(msgKey))
            handleMessagesUpdate(
              msgs,
              messagesResult.value.toolStats,
              fresh,
              messagesResult.value.tokenStats
            )
          }
        }

        // Messages have been snapshot-guarded for a while; tasks were not, so every 2s
        // tick handed React new array identities for unchanged content and churned the
        // root state the whole dashboard hangs off (#856).
        const currentDeps = depsRef.current
        applyFulfilled(tasksResult, (value) => {
          const tasks = value.tasks ?? []
          const summary = value.summary ?? null
          if (!snapshotChanged(JSON.stringify([tasks, summary]), tasksPrevSnapshotRef)) return
          currentDeps.onTasks(tasks, summary)
        })
        applyFulfilled(projectTasksResult, (value) => {
          const tasks = value.tasks ?? []
          const summary = value.summary ?? null
          if (!snapshotChanged(JSON.stringify([tasks, summary]), projectTasksPrevSnapshotRef))
            return
          currentDeps.onProjectTasks(tasks, summary)
        })
      } catch {
        // ignore polling errors
      }
    })

    void pollSessionData()
    const id = setInterval(() => void pollSessionData(), 2000)
    return () => clearInterval(id)
  }, [selectedProjectCwd, selectedSessionId])
}
