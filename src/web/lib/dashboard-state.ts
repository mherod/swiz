import { useCallback, useMemo, useOptimistic, useRef, useState, useTransition } from "react"
import type {
  ProjectSessions,
  ProjectTask,
  SessionMessage,
  SessionTask,
  SessionTaskSummary,
  ToolStat,
} from "../components/session-browser.tsx"
import {
  getQueryParam,
  hasProjectMessages,
  setQueryParams,
  toSortedEvents,
} from "./dashboard-helpers.ts"
import {
  type ActiveHookDispatch,
  applyInitialSelection,
  type MetricsResponse,
  useDashboardOverviewPolling,
  useProjectMetricsPolling,
  useSessionPolling,
  type WatchesResponse,
} from "./dashboard-hooks.ts"
import { postJson } from "./http.ts"

export type ActiveView = "dashboard" | "issues" | "tasks" | "transcript" | "logs" | "settings"

type AgentProcessOptimisticAction =
  | { type: "sync"; providers: Record<string, number[]> }
  | { type: "removePid"; pid: number }

type ProjectsOptimisticAction =
  | { type: "sync"; projects: ProjectSessions[] }
  | { type: "removeSession"; cwd: string; sessionId: string }

type PendingSessionDeletionAction =
  | { type: "add"; key: string }
  | { type: "remove"; key: string }
  | { type: "sync"; keys: Set<string> }

function removePidFromProviders(
  providers: Record<string, number[]>,
  pid: number
): Record<string, number[]> {
  const next: Record<string, number[]> = {}
  for (const [provider, pids] of Object.entries(providers)) {
    const filtered = pids.filter((candidate) => candidate !== pid)
    if (filtered.length > 0) next[provider] = filtered
  }
  return next
}

function removeSessionFromProjects(
  projects: ProjectSessions[],
  cwd: string,
  sessionId: string
): ProjectSessions[] {
  return projects
    .map((project) => {
      if (project.cwd !== cwd) return project
      const nextSessions = project.sessions.filter((session) => session.id !== sessionId)
      return {
        ...project,
        sessions: nextSessions,
        sessionCount: Math.max(project.sessionCount - 1, 0),
      }
    })
    .filter((project) => project.sessions.length > 0)
}

function sessionDeletionKey(cwd: string, sessionId: string): string {
  return `${cwd}::${sessionId}`
}

function applyPendingSessionDeletions(
  projects: ProjectSessions[],
  pendingDeletionKeys: Set<string>
): ProjectSessions[] {
  if (pendingDeletionKeys.size === 0) return projects
  return projects
    .map((project) => {
      const nextSessions = project.sessions.filter(
        (session) => !pendingDeletionKeys.has(sessionDeletionKey(project.cwd, session.id))
      )
      return {
        ...project,
        sessions: nextSessions,
        sessionCount: nextSessions.length,
      }
    })
    .filter((project) => project.sessions.length > 0)
}

function sessionRecency(session: ProjectSessions["sessions"][number]): number {
  return session.lastMessageAt ?? session.startedAt ?? session.mtime ?? 0
}

function getNextSessionCandidate(
  projects: ProjectSessions[],
  deletedCwd: string,
  deletedSessionId: string
): { cwd: string; sessionId: string } | null {
  const project = projects.find((candidate) => candidate.cwd === deletedCwd)
  const sameProjectSessions =
    project?.sessions.filter((session) => session.id !== deletedSessionId) ?? []
  const nextInProject = sameProjectSessions
    .slice()
    .sort((a, b) => sessionRecency(b) - sessionRecency(a))[0]
  if (nextInProject) {
    return { cwd: deletedCwd, sessionId: nextInProject.id }
  }

  const fallback = projects
    .flatMap((candidateProject) =>
      candidateProject.sessions
        .filter(
          (session) => !(candidateProject.cwd === deletedCwd && session.id === deletedSessionId)
        )
        .map((session) => ({ cwd: candidateProject.cwd, session }))
    )
    .sort((a, b) => sessionRecency(b.session) - sessionRecency(a.session))[0]

  return fallback ? { cwd: fallback.cwd, sessionId: fallback.session.id } : null
}

function cacheSummary(status: Record<string, number> | null): { total: number; warm: number } {
  if (!status) return { total: 0, warm: 0 }
  const keys = [
    "snapshotCacheSize",
    "ghCacheSize",
    "eligibilityCacheSize",
    "transcriptIndexSize",
    "cooldownRegistrySize",
    "gitStateCacheSize",
    "projectSettingsCacheSize",
    "manifestCacheSize",
  ] as const
  let total = 0
  let warm = 0
  for (const key of keys) {
    const value = status[key] ?? 0
    total += value
    if (value > 0) warm += 1
  }
  return { total, warm }
}

function useSessionDataLoaders() {
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([])
  const [sessionToolStats, setSessionToolStats] = useState<ToolStat[]>([])
  const [sessionTasks, setSessionTasks] = useState<SessionTask[]>([])
  const [sessionTaskSummary, setSessionTaskSummary] = useState<SessionTaskSummary | null>(null)
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([])
  const [projectTaskSummary, setProjectTaskSummary] = useState<SessionTaskSummary | null>(null)
  const [projectTasksLoading, setProjectTasksLoading] = useState(false)
  const [sessionTasksLoading, setSessionTasksLoading] = useState(false)
  const [newMessageKeys, setNewMessageKeys] = useState<Set<string>>(new Set())
  const [messagesLoading, setMessagesLoading] = useState(false)

  const loadMessages = useCallback(async (cwd: string, sessionId: string) => {
    setMessagesLoading(true)
    try {
      const result = await postJson<{
        messages: SessionMessage[]
        toolStats?: ToolStat[]
      }>("/sessions/messages", { cwd, sessionId, limit: 30 })
      setNewMessageKeys(new Set())
      setSessionMessages(result.messages ?? [])
      setSessionToolStats(result.toolStats ?? [])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const loadTasks = useCallback(async (cwd: string, sessionId: string) => {
    setSessionTasksLoading(true)
    try {
      const result = await postJson<{
        tasks: SessionTask[]
        summary?: SessionTaskSummary
      }>("/sessions/tasks", { cwd, sessionId, limit: 20 })
      setSessionTasks(result.tasks ?? [])
      setSessionTaskSummary(result.summary ?? null)
    } finally {
      setSessionTasksLoading(false)
    }
  }, [])

  const loadProjectTasks = useCallback(async (cwd: string) => {
    setProjectTasksLoading(true)
    try {
      const result = await postJson<{
        tasks: ProjectTask[]
        summary?: SessionTaskSummary
      }>("/projects/tasks", { cwd, limit: 80 })
      setProjectTasks(result.tasks ?? [])
      setProjectTaskSummary(result.summary ?? null)
    } finally {
      setProjectTasksLoading(false)
    }
  }, [])

  const clearSession = useCallback(() => {
    setSessionMessages([])
    setSessionTasks([])
    setSessionTaskSummary(null)
  }, [])

  return {
    sessionMessages,
    setSessionMessages,
    sessionToolStats,
    setSessionToolStats,
    sessionTasks,
    setSessionTasks,
    sessionTaskSummary,
    setSessionTaskSummary,
    projectTasks,
    setProjectTasks,
    projectTaskSummary,
    setProjectTaskSummary,
    projectTasksLoading,
    sessionTasksLoading,
    newMessageKeys,
    setNewMessageKeys,
    messagesLoading,
    loadMessages,
    loadTasks,
    loadProjectTasks,
    clearSession,
  }
}

function useCacheStatusWithJitterFilter() {
  const [cacheStatus, setCacheStatus] = useState<Record<string, number> | null>(null)
  const lastChangeAtRef = useRef(0)
  const onCacheStatus = useCallback((nextStatus: Record<string, number> | null) => {
    setCacheStatus((prevStatus) => {
      if (!prevStatus) {
        lastChangeAtRef.current = Date.now()
        return nextStatus
      }
      const prev = cacheSummary(prevStatus)
      const next = cacheSummary(nextStatus)
      const now = Date.now()
      const changedRecently = now - lastChangeAtRef.current < 12_000
      const minorJitter =
        Math.abs(next.total - prev.total) <= 2 && Math.abs(next.warm - prev.warm) <= 1
      if (changedRecently && minorJitter) return prevStatus
      lastChangeAtRef.current = now
      return nextStatus
    })
  }, [])
  return { cacheStatus, onCacheStatus }
}

type DashboardActionsInput = ReturnType<typeof useOptimisticDashboardState> & {
  loaders: ReturnType<typeof useSessionDataLoaders>
  setError: (msg: string) => void
  setDeletingSessionId: (id: string | null) => void
  startSelectionTransition: (fn: () => void) => void
  startMutationTransition: (fn: () => void) => void
}

function useSelectionActions(input: DashboardActionsInput) {
  const {
    loaders,
    optimisticProjects,
    setSelectedProjectCwd,
    setSelectedSessionId,
    startSelectionTransition,
    addOptimisticProjectCwd,
    addOptimisticSessionId,
  } = input

  const handleSelectSession = useCallback(
    (cwd: string, sessionId: string) => {
      startSelectionTransition(() => {
        setSelectedProjectCwd(cwd)
        setSelectedSessionId(sessionId)
        setQueryParams({ project: cwd, session: sessionId })
        addOptimisticProjectCwd(cwd)
        addOptimisticSessionId(sessionId)
        void Promise.all([
          loaders.loadMessages(cwd, sessionId),
          loaders.loadTasks(cwd, sessionId),
          loaders.loadProjectTasks(cwd),
        ]).catch(() => {})
      })
    },
    [
      loaders.loadMessages,
      loaders.loadTasks,
      loaders.loadProjectTasks,
      addOptimisticProjectCwd,
      addOptimisticSessionId,
      setSelectedProjectCwd,
      setSelectedSessionId,
      startSelectionTransition,
    ]
  )

  const handleSelectProject = useCallback(
    (cwd: string) => {
      const project = optimisticProjects.find((p) => p.cwd === cwd)
      const firstSession = project?.sessions[0]
      if (firstSession) {
        setSelectedProjectCwd(cwd)
        setSelectedSessionId(firstSession.id)
        setQueryParams({ project: cwd, session: firstSession.id })
        startSelectionTransition(() => {
          addOptimisticProjectCwd(cwd)
          addOptimisticSessionId(firstSession.id)
          void Promise.all([
            loaders.loadMessages(cwd, firstSession.id),
            loaders.loadTasks(cwd, firstSession.id),
            loaders.loadProjectTasks(cwd),
          ]).catch(() => {})
        })
      } else {
        setSelectedProjectCwd(cwd)
        setSelectedSessionId(null)
        loaders.clearSession()
        void loaders.loadProjectTasks(cwd)
        setQueryParams({ project: cwd, session: null })
      }
    },
    [
      optimisticProjects,
      loaders,
      addOptimisticProjectCwd,
      addOptimisticSessionId,
      setSelectedProjectCwd,
      setSelectedSessionId,
      startSelectionTransition,
    ]
  )

  return { handleSelectSession, handleSelectProject }
}

function useMutationActions(
  input: DashboardActionsInput,
  handleSelectSession: (cwd: string, sessionId: string) => void
) {
  const {
    loaders,
    optimisticProjects,
    optimisticPendingSessionDeletions,
    selectedSessionId,
    setSelectedSessionId,
    setProjects,
    setAgentProcessProviders,
    setError,
    setDeletingSessionId,
    setPendingSessionDeletions,
    startMutationTransition,
    addOptimisticSessionId,
    addOptimisticProjects,
    addOptimisticPendingSessionDeletions,
    addOptimisticKillingPid,
  } = input

  const handleKillAgentPid = useCallback(
    (pid: number) => {
      startMutationTransition(async () => {
        addOptimisticKillingPid({ type: "add", pid })
        try {
          const url = "/process/agents/kill"
          await postJson<{ ok: boolean; pid: number }>(url, { pid })
          setAgentProcessProviders((prev) => removePidFromProviders(prev, pid))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    },
    [addOptimisticKillingPid, setAgentProcessProviders, setError, startMutationTransition]
  )

  const handleDeleteSession = useCallback(
    (cwd: string, sessionId: string) => {
      setDeletingSessionId(sessionId)
      const deletionKey = sessionDeletionKey(cwd, sessionId)
      startMutationTransition(async () => {
        addOptimisticPendingSessionDeletions({ type: "add", key: deletionKey })
        addOptimisticProjects({ type: "removeSession", cwd, sessionId })
        try {
          await postJson<{
            ok: boolean
            deletedCount: number
            sessionIds: string[]
          }>("/sessions/delete", { cwd, sessionId })
          const visible = applyPendingSessionDeletions(
            optimisticProjects,
            optimisticPendingSessionDeletions
          )
          const next = removeSessionFromProjects(visible, cwd, sessionId)
          setProjects(() => next)
          if (selectedSessionId === sessionId) {
            const candidate = getNextSessionCandidate(next, cwd, sessionId)
            if (candidate) {
              handleSelectSession(candidate.cwd, candidate.sessionId)
            } else {
              setSelectedSessionId(null)
              addOptimisticSessionId(null)
              loaders.clearSession()
              setQueryParams({ session: null })
            }
          }
        } finally {
          setPendingSessionDeletions((previous) => {
            const s = new Set(previous)
            s.delete(deletionKey)
            return s
          })
          addOptimisticPendingSessionDeletions({
            type: "remove",
            key: deletionKey,
          })
          setDeletingSessionId(null)
        }
      })
    },
    [
      addOptimisticPendingSessionDeletions,
      addOptimisticProjects,
      addOptimisticSessionId,
      handleSelectSession,
      loaders,
      optimisticPendingSessionDeletions,
      optimisticProjects,
      selectedSessionId,
      setDeletingSessionId,
      setPendingSessionDeletions,
      setProjects,
      setSelectedSessionId,
      startMutationTransition,
    ]
  )

  return { handleKillAgentPid, handleDeleteSession }
}

function useDashboardActions(input: DashboardActionsInput) {
  const { handleSelectSession, handleSelectProject } = useSelectionActions(input)
  const { handleKillAgentPid, handleDeleteSession } = useMutationActions(input, handleSelectSession)
  return {
    handleSelectSession,
    handleSelectProject,
    handleKillAgentPid,
    handleDeleteSession,
  }
}

function useOptimisticDashboardState() {
  const [projects, setProjects] = useState<ProjectSessions[]>([])
  const [agentProcessProviders, setAgentProcessProviders] = useState<Record<string, number[]>>({})
  const [selectedProjectCwd, setSelectedProjectCwd] = useState<string | null>(() =>
    getQueryParam("project")
  )
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() =>
    getQueryParam("session")
  )
  const [optimisticProjectCwd, addOptimisticProjectCwd] = useOptimistic(
    selectedProjectCwd,
    (_current, next: string | null) => next
  )
  const [optimisticSessionId, addOptimisticSessionId] = useOptimistic(
    selectedSessionId,
    (_current, next: string | null) => next
  )
  const [optimisticProjects, addOptimisticProjects] = useOptimistic(
    projects,
    (current, action: ProjectsOptimisticAction) => {
      if (action.type === "sync") return action.projects
      return removeSessionFromProjects(current, action.cwd, action.sessionId)
    }
  )
  const [optimisticAgentProcessProviders, addOptimisticAgentProcessProviders] = useOptimistic(
    agentProcessProviders,
    (current, action: AgentProcessOptimisticAction) => {
      if (action.type === "sync") return action.providers
      return removePidFromProviders(current, action.pid)
    }
  )
  const [pendingSessionDeletions, setPendingSessionDeletions] = useState<Set<string>>(new Set())
  const [optimisticPendingSessionDeletions, addOptimisticPendingSessionDeletions] = useOptimistic(
    pendingSessionDeletions,
    (current, action: PendingSessionDeletionAction) => {
      if (action.type === "sync") return action.keys
      const next = new Set(current)
      if (action.type === "add") next.add(action.key)
      else next.delete(action.key)
      return next
    }
  )
  const [killingPids] = useState<Set<number>>(new Set())
  const [optimisticKillingPids, addOptimisticKillingPid] = useOptimistic(
    killingPids,
    (current, action: { type: "add" | "remove"; pid: number }) => {
      const next = new Set(current)
      if (action.type === "add") next.add(action.pid)
      else next.delete(action.pid)
      return next
    }
  )
  return {
    projects,
    setProjects,
    agentProcessProviders,
    setAgentProcessProviders,
    selectedProjectCwd,
    setSelectedProjectCwd,
    selectedSessionId,
    setSelectedSessionId,
    optimisticProjectCwd,
    addOptimisticProjectCwd,
    optimisticSessionId,
    addOptimisticSessionId,
    optimisticProjects,
    addOptimisticProjects,
    optimisticAgentProcessProviders,
    addOptimisticAgentProcessProviders,
    pendingSessionDeletions,
    setPendingSessionDeletions,
    optimisticPendingSessionDeletions,
    addOptimisticPendingSessionDeletions,
    optimisticKillingPids,
    addOptimisticKillingPid,
  }
}

interface DerivedStateInput {
  optimisticProjects: ProjectSessions[]
  optimisticPendingSessionDeletions: Set<string>
  optimisticProjectCwd: string | null
  optimisticSessionId: string | null
  watches: WatchesResponse | null
  metrics: MetricsResponse | null
  projectEvents: Array<{ name: string; count: number; avgMs: number }>
  sessionMessages: SessionMessage[]
  activeHookDispatches: ActiveHookDispatch[]
}

function useDerivedDashboardState(input: DerivedStateInput) {
  const {
    optimisticProjects,
    optimisticPendingSessionDeletions,
    optimisticProjectCwd,
    optimisticSessionId,
    watches,
    metrics,
    projectEvents,
    sessionMessages,
    activeHookDispatches,
  } = input
  const m = metrics ?? {}
  const visibleProjects = useMemo(
    () => applyPendingSessionDeletions(optimisticProjects, optimisticPendingSessionDeletions),
    [optimisticProjects, optimisticPendingSessionDeletions]
  )
  const projectCount = useMemo(
    () => visibleProjects.filter(hasProjectMessages).length,
    [visibleProjects]
  )
  const watchCount = useMemo(() => (watches?.active ?? []).length, [watches?.active])
  const activeProject = useMemo(
    () =>
      optimisticProjectCwd ? visibleProjects.find((p) => p.cwd === optimisticProjectCwd) : null,
    [visibleProjects, optimisticProjectCwd]
  )
  const activeSession = useMemo(
    () =>
      optimisticSessionId
        ? (activeProject?.sessions.find((s) => s.id === optimisticSessionId) ?? null)
        : null,
    [activeProject?.sessions, optimisticSessionId]
  )
  const displayedMessages = useMemo(() => {
    if (!optimisticSessionId) return sessionMessages
    const d = activeHookDispatches.find((h) => h.sessionId === optimisticSessionId)
    if (!d) return sessionMessages
    const syntheticMessage: SessionMessage = {
      role: "assistant",
      timestamp: new Date(d.startedAt).toISOString(),
      text: d.toolName ? `Running **${d.toolName}**...` : `Running **${d.canonicalEvent}**...`,
      toolCalls: d.toolName ? [{ name: d.toolName, detail: d.toolInputSummary ?? "" }] : [],
    }
    return [...sessionMessages, syntheticMessage]
  }, [sessionMessages, activeHookDispatches, optimisticSessionId])
  const metricsEvents = useMemo(
    () => (projectEvents.length > 0 ? projectEvents : toSortedEvents(m.byEvent)),
    [projectEvents, m.byEvent]
  )
  return {
    m,
    visibleProjects,
    projectCount,
    watchCount,
    activeProject,
    activeSession,
    displayedMessages,
    metricsEvents,
  }
}

export type DashboardState = ReturnType<typeof useDashboardState>

export function useDashboardState() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const { cacheStatus, onCacheStatus } = useCacheStatusWithJitterFilter()
  const [watches, setWatches] = useState<WatchesResponse | null>(null)
  const os = useOptimisticDashboardState()
  const [, startSelectionTransition] = useTransition()
  const [, startMutationTransition] = useTransition()
  const loaders = useSessionDataLoaders()
  const [projectEvents, setProjectEvents] = useState<
    Array<{ name: string; count: number; avgMs: number }>
  >([])
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [activeHookDispatches, setActiveHookDispatches] = useState<ActiveHookDispatch[]>([])
  const [activeView, _setActiveView] = useState<ActiveView>(
    () => (getQueryParam("view") as ActiveView) || "dashboard"
  )
  const setActiveView = useCallback((view: ActiveView) => {
    _setActiveView(view)
    setQueryParams({ view })
  }, [])
  const [error, setError] = useState("")
  const [lastUpdated, setLastUpdated] = useState("starting")

  const actions = useDashboardActions({
    loaders,
    ...os,
    setError,
    setDeletingSessionId,
    startSelectionTransition,
    startMutationTransition,
  })

  useDashboardOverviewPolling({
    onMetrics: setMetrics,
    onCacheStatus,
    onWatches: setWatches,
    onProjects: (loaded) => {
      os.setProjects(loaded)
      os.addOptimisticProjects({ type: "sync", projects: loaded })
    },
    onAgentProcesses: (providers) => {
      os.setAgentProcessProviders(providers)
      os.addOptimisticAgentProcessProviders({ type: "sync", providers })
    },
    onActiveDispatches: setActiveHookDispatches,
    onError: setError,
    onLastUpdated: setLastUpdated,
    onInitialLoad: (loaded) =>
      applyInitialSelection({
        projects: loaded,
        selectSession: actions.handleSelectSession,
        selectProjectOnly: os.setSelectedProjectCwd,
        loadProjectTasks: loaders.loadProjectTasks,
      }),
  })

  useProjectMetricsPolling(os.selectedProjectCwd, setProjectEvents)

  useSessionPolling({
    selectedProjectCwd: os.selectedProjectCwd,
    selectedSessionId: os.selectedSessionId,
    onMessages: (messages, toolStats) => {
      loaders.setSessionMessages(messages)
      loaders.setSessionToolStats(toolStats)
    },
    onTasks: (tasks, summary) => {
      loaders.setSessionTasks(tasks)
      loaders.setSessionTaskSummary(summary)
    },
    onProjectTasks: (tasks, summary) => {
      loaders.setProjectTasks(tasks)
      loaders.setProjectTaskSummary(summary)
    },
    onNewMessageKeys: loaders.setNewMessageKeys,
  })

  const derived = useDerivedDashboardState({
    optimisticProjects: os.optimisticProjects,
    optimisticPendingSessionDeletions: os.optimisticPendingSessionDeletions,
    optimisticProjectCwd: os.optimisticProjectCwd,
    optimisticSessionId: os.optimisticSessionId,
    watches,
    metrics,
    projectEvents,
    sessionMessages: loaders.sessionMessages,
    activeHookDispatches,
  })

  return {
    error,
    lastUpdated,
    activeHookDispatches,
    activeView,
    setActiveView,
    deletingSessionId,
    cacheStatus,
    ...derived,
    ...actions,
    optimisticAgentProcessProviders: os.optimisticAgentProcessProviders,
    optimisticKillingPids: os.optimisticKillingPids,
    optimisticProjectCwd: os.optimisticProjectCwd,
    optimisticSessionId: os.optimisticSessionId,
    sessionMessages: loaders.sessionMessages,
    messagesLoading: loaders.messagesLoading,
    newMessageKeys: loaders.newMessageKeys,
    sessionToolStats: loaders.sessionToolStats,
    sessionTasks: loaders.sessionTasks,
    sessionTaskSummary: loaders.sessionTaskSummary,
    sessionTasksLoading: loaders.sessionTasksLoading,
    projectTasks: loaders.projectTasks,
    projectTaskSummary: loaders.projectTaskSummary,
    projectTasksLoading: loaders.projectTasksLoading,
  }
}
