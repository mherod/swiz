import { useCallback, useOptimistic, useState, useTransition } from "react"
import {
  getQueryParam,
  hasProjectMessages,
  msgKey,
  setQueryParams,
  toSortedEvents,
} from "../lib/dashboard-helpers.ts"
import {
  applyInitialSelection,
  type MetricsResponse,
  useDashboardOverviewPolling,
  useProjectMetricsPolling,
  useSessionPolling,
  type WatchesResponse,
} from "../lib/dashboard-hooks.ts"
import { postJson } from "../lib/http.ts"
import { Header } from "./header.tsx"
import { MetricsRail } from "./metrics-rail.tsx"
import {
  type ProjectSessions,
  type ProjectTask,
  type SessionMessage,
  SessionMessages,
  SessionNav,
  type SessionTask,
  type SessionTaskSummary,
  type ToolStat,
} from "./session-browser.tsx"

type AgentProcessOptimisticAction =
  | { type: "sync"; providers: Record<string, number[]> }
  | { type: "removePid"; pid: number }

type ProjectsOptimisticAction =
  | { type: "sync"; projects: ProjectSessions[] }
  | { type: "removeSession"; cwd: string; sessionId: string }

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

export function DashboardApp() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [cacheStatus, setCacheStatus] = useState<Record<string, number> | null>(null)
  const [watches, setWatches] = useState<WatchesResponse | null>(null)
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
  const [, startSelectionTransition] = useTransition()
  const [, startMutationTransition] = useTransition()
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
  const [projectEvents, setProjectEvents] = useState<
    Array<{ name: string; count: number; avgMs: number }>
  >([])
  const [killingPid, setKillingPid] = useState<number | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [lastUpdated, setLastUpdated] = useState("starting")

  const loadMessages = useCallback(async (cwd: string, sessionId: string) => {
    setMessagesLoading(true)
    try {
      const result = await postJson<{ messages: SessionMessage[]; toolStats?: ToolStat[] }>(
        "/sessions/messages",
        { cwd, sessionId, limit: 30 }
      )
      const msgs = result.messages ?? []
      setNewMessageKeys(new Set())
      setSessionMessages(msgs)
      setSessionToolStats(result.toolStats ?? [])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const loadTasks = useCallback(async (cwd: string, sessionId: string) => {
    setSessionTasksLoading(true)
    try {
      const result = await postJson<{ tasks: SessionTask[]; summary?: SessionTaskSummary }>(
        "/sessions/tasks",
        { cwd, sessionId, limit: 20 }
      )
      setSessionTasks(result.tasks ?? [])
      setSessionTaskSummary(result.summary ?? null)
    } finally {
      setSessionTasksLoading(false)
    }
  }, [])

  const loadProjectTasks = useCallback(async (cwd: string) => {
    setProjectTasksLoading(true)
    try {
      const result = await postJson<{ tasks: ProjectTask[]; summary?: SessionTaskSummary }>(
        "/projects/tasks",
        { cwd, limit: 80 }
      )
      setProjectTasks(result.tasks ?? [])
      setProjectTaskSummary(result.summary ?? null)
    } finally {
      setProjectTasksLoading(false)
    }
  }, [])

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
            loadMessages(cwd, firstSession.id),
            loadTasks(cwd, firstSession.id),
            loadProjectTasks(cwd),
          ]).catch(() => {})
        })
      } else {
        setSelectedProjectCwd(cwd)
        setSelectedSessionId(null)
        setSessionMessages([])
        setSessionTasks([])
        setSessionTaskSummary(null)
        void loadProjectTasks(cwd)
        setQueryParams({ project: cwd, session: null })
      }
    },
    [
      optimisticProjects,
      loadMessages,
      loadTasks,
      loadProjectTasks,
      addOptimisticProjectCwd,
      addOptimisticSessionId,
    ]
  )

  const handleSelectSession = useCallback(
    (cwd: string, sessionId: string) => {
      startSelectionTransition(() => {
        setSelectedProjectCwd(cwd)
        setSelectedSessionId(sessionId)
        setQueryParams({ project: cwd, session: sessionId })
        addOptimisticProjectCwd(cwd)
        addOptimisticSessionId(sessionId)
        void Promise.all([
          loadMessages(cwd, sessionId),
          loadTasks(cwd, sessionId),
          loadProjectTasks(cwd),
        ]).catch(() => {})
      })
    },
    [loadMessages, loadTasks, loadProjectTasks, addOptimisticProjectCwd, addOptimisticSessionId]
  )

  const handleKillAgentPid = useCallback(
    (pid: number) => {
      setKillingPid(pid)
      startMutationTransition(async () => {
        addOptimisticAgentProcessProviders({ type: "removePid", pid })
        try {
          await postJson<{ ok: boolean; pid: number }>("/process/agents/kill", { pid })
          setAgentProcessProviders((previous) => removePidFromProviders(previous, pid))
        } finally {
          setKillingPid(null)
        }
      })
    },
    [addOptimisticAgentProcessProviders]
  )

  const handleDeleteSession = useCallback(
    (cwd: string, sessionId: string) => {
      setDeletingSessionId(sessionId)
      startMutationTransition(async () => {
        addOptimisticProjects({ type: "removeSession", cwd, sessionId })
        try {
          await postJson<{ ok: boolean; deletedCount: number; sessionIds: string[] }>(
            "/sessions/delete",
            {
              cwd,
              sessionId,
            }
          )
          setProjects((previous) => removeSessionFromProjects(previous, cwd, sessionId))
          if (selectedSessionId === sessionId) {
            setSelectedSessionId(null)
            addOptimisticSessionId(null)
            setSessionMessages([])
            setSessionTasks([])
            setSessionTaskSummary(null)
            setQueryParams({ session: null })
          }
        } finally {
          setDeletingSessionId(null)
        }
      })
    },
    [addOptimisticProjects, addOptimisticSessionId, selectedSessionId]
  )

  useDashboardOverviewPolling({
    onMetrics: setMetrics,
    onCacheStatus: setCacheStatus,
    onWatches: setWatches,
    onProjects: (loadedProjects) => {
      setProjects(loadedProjects)
      addOptimisticProjects({ type: "sync", projects: loadedProjects })
    },
    onAgentProcesses: (providers) => {
      setAgentProcessProviders(providers)
      addOptimisticAgentProcessProviders({ type: "sync", providers })
    },
    onError: setError,
    onLastUpdated: setLastUpdated,
    onInitialLoad: (loadedProjects) =>
      applyInitialSelection({
        projects: loadedProjects,
        selectSession: handleSelectSession,
        selectProjectOnly: setSelectedProjectCwd,
        loadProjectTasks,
      }),
  })

  useProjectMetricsPolling(selectedProjectCwd, setProjectEvents)

  useSessionPolling({
    selectedProjectCwd,
    selectedSessionId,
    onMessages: (messages, toolStats) => {
      setSessionMessages(messages)
      setSessionToolStats(toolStats)
    },
    onTasks: (tasks, summary) => {
      setSessionTasks(tasks)
      setSessionTaskSummary(summary)
    },
    onProjectTasks: (tasks, summary) => {
      setProjectTasks(tasks)
      setProjectTaskSummary(summary)
    },
    onNewMessageKeys: setNewMessageKeys,
  })

  const m = metrics ?? {}
  const projectCount = optimisticProjects.filter(hasProjectMessages).length
  const watchCount = (watches?.active ?? []).length
  const activeProject = optimisticProjectCwd
    ? optimisticProjects.find((project) => project.cwd === optimisticProjectCwd)
    : null
  const activeSession = optimisticSessionId
    ? (activeProject?.sessions.find((session) => session.id === optimisticSessionId) ?? null)
    : null

  if (error) {
    return (
      <div className="bento">
        <section className="card bento-error" role="alert" aria-live="assertive">
          <h2>Error</h2>
          <p>{error}</p>
        </section>
      </div>
    )
  }

  return (
    <div className="bento">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Dashboard updated at {lastUpdated}.
      </p>
      <Header
        lastUpdated={lastUpdated}
        uptime={m.uptimeHuman ?? "starting"}
        totalDispatches={m.totalDispatches ?? 0}
        projects={projectCount}
        activeWatches={watchCount}
      />
      <SessionNav
        projects={optimisticProjects}
        activeAgentPidsByProvider={optimisticAgentProcessProviders}
        killingPid={killingPid}
        deletingSessionId={deletingSessionId}
        selectedProjectCwd={optimisticProjectCwd}
        selectedSessionId={optimisticSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
        onKillAgentPid={handleKillAgentPid}
        onDeleteSession={handleDeleteSession}
      />
      <SessionMessages
        messages={sessionMessages}
        loading={messagesLoading}
        newKeys={newMessageKeys}
        msgKey={msgKey}
        toolStats={sessionToolStats}
        tasks={sessionTasks}
        taskSummary={sessionTaskSummary}
        tasksLoading={sessionTasksLoading}
        projectTasks={projectTasks}
        projectTaskSummary={projectTaskSummary}
        projectTasksLoading={projectTasksLoading}
      />
      <MetricsRail
        events={projectEvents.length > 0 ? projectEvents : toSortedEvents(m.byEvent)}
        scope={optimisticProjectCwd ? "project" : "global"}
        cacheStatus={cacheStatus}
        activeSession={activeSession}
        loadedMessageCount={sessionMessages.length}
        sessionToolStats={sessionToolStats}
      />
    </div>
  )
}
