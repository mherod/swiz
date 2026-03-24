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
  byEvent?: Record<string, { count?: number; avgMs?: number }>
}

export interface WatchesResponse {
  active?: unknown[]
}

export interface AgentProcessesResponse {
  providers?: Record<string, number[]>
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

export function useDashboardOverviewPolling(deps: OverviewPollingDeps) {
  const prevCoreSnapshotRef = useRef("")
  const prevCacheSnapshotRef = useRef("")
  const initialLoadDone = useRef(false)

  useEffect(() => {
    async function fetchAllData() {
      const project = getQueryParam("project")
      const session = getQueryParam("session")
      const [m, cs, w, pr, ap, ad] = await Promise.all([
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
      const cacheSnapshot = JSON.stringify(cs)
      const coreChanged = coreSnapshot !== prevCoreSnapshotRef.current
      const cacheChanged = cacheSnapshot !== prevCacheSnapshotRef.current
      if (!coreChanged && !cacheChanged) return
      if (cacheChanged) {
        prevCacheSnapshotRef.current = cacheSnapshot
        deps.onCacheStatus(cs)
      }
      if (!coreChanged) return
      prevCoreSnapshotRef.current = coreSnapshot
      const loadedProjects = pr.projects ?? []
      deps.onMetrics(m)
      deps.onWatches(w)
      deps.onProjects(loadedProjects)
      deps.onAgentProcesses(ap.providers ?? {})
      deps.onActiveDispatches(ad.active ?? [])
      deps.onError("")
      deps.onLastUpdated(new Date().toLocaleTimeString())

      if (!initialLoadDone.current) {
        initialLoadDone.current = true
        deps.onInitialLoad(loadedProjects)
      }
    }

    async function refresh() {
      try {
        const data = await fetchAllData()
        applyUpdates(data)
      } catch (err) {
        deps.onError(err instanceof Error ? err.message : "Unknown fetch failure")
      }
    }

    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [deps])
}

export function useProjectMetricsPolling(
  selectedProjectCwd: string | null,
  setProjectEvents: (events: Array<{ name: string; count: number; avgMs: number }>) => void
) {
  useEffect(() => {
    if (!selectedProjectCwd) {
      setProjectEvents([])
      return
    }
    const cwd = selectedProjectCwd
    async function fetchProjectMetrics() {
      try {
        const pm = await fetchJson<MetricsResponse>(`/metrics?project=${encodeURIComponent(cwd)}`)
        setProjectEvents(toSortedEvents(pm.byEvent))
      } catch {
        setProjectEvents([])
      }
    }
    void fetchProjectMetrics()
    const id = setInterval(() => void fetchProjectMetrics(), 5000)
    return () => clearInterval(id)
  }, [selectedProjectCwd, setProjectEvents])
}

interface SessionPollingDeps {
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onMessages: (messages: SessionMessage[], toolStats: ToolStat[]) => void
  onTasks: (tasks: SessionTask[], summary: SessionTaskSummary | null) => void
  onProjectTasks: (tasks: ProjectTask[], summary: SessionTaskSummary | null) => void
  onNewMessageKeys: (keys: Set<string>) => void
}

export function useSessionPolling(deps: SessionPollingDeps) {
  const knownKeysRef = useRef<Set<string>>(new Set())
  const messagesPrevSnapshotRef = useRef("")

  useEffect(() => {
    if (!deps.selectedProjectCwd || !deps.selectedSessionId) return
    const cwd = deps.selectedProjectCwd
    const sid = deps.selectedSessionId

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
      fresh: Set<string>
    ): void {
      deps.onNewMessageKeys(fresh)
      deps.onMessages(msgs, toolStats ?? [])
      if (fresh.size > 0) {
        setTimeout(() => deps.onNewMessageKeys(new Set()), 500)
      }
    }

    async function pollSessionData() {
      try {
        const [messagesResult, tasksResult, projectTasksResult] = await Promise.all([
          postJson<{ messages: SessionMessage[]; toolStats?: ToolStat[] }>("/sessions/messages", {
            cwd,
            sessionId: sid,
            limit: 30,
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

        const msgs = messagesResult.messages ?? []
        const snap = JSON.stringify(msgs)
        if (snap !== messagesPrevSnapshotRef.current) {
          messagesPrevSnapshotRef.current = snap
          const fresh = computeFreshMessageKeys(msgs, knownKeysRef.current)
          knownKeysRef.current = new Set(msgs.map(msgKey))
          handleMessagesUpdate(msgs, messagesResult.toolStats, fresh)
        }

        deps.onTasks(tasksResult.tasks ?? [], tasksResult.summary ?? null)
        deps.onProjectTasks(projectTasksResult.tasks ?? [], projectTasksResult.summary ?? null)
      } catch {
        // ignore polling errors
      }
    }

    const id = setInterval(() => void pollSessionData(), 2000)
    return () => clearInterval(id)
  }, [deps])
}
