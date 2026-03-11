import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react"
import {
  getQueryParam,
  hasProjectMessages,
  msgKey,
  setQueryParams,
  toSortedEvents,
} from "../lib/dashboard-helpers.ts"
import { fetchJson, postJson } from "../lib/http.ts"
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

interface MetricsResponse {
  uptimeHuman?: string
  totalDispatches?: number
  byEvent?: Record<string, { count?: number; avgMs?: number }>
}

interface WatchesResponse {
  active?: unknown[]
}

export function DashboardApp() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [cacheStatus, setCacheStatus] = useState<Record<string, number> | null>(null)
  const [watches, setWatches] = useState<WatchesResponse | null>(null)
  const [projects, setProjects] = useState<ProjectSessions[]>([])
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
  const [, startSelectionTransition] = useTransition()
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
  const [error, setError] = useState("")
  const [lastUpdated, setLastUpdated] = useState("starting")

  const prevSnapshotRef = useRef("")
  const initialLoadDone = useRef(false)
  const knownKeysRef = useRef<Set<string>>(new Set())
  const messagesPrevSnapshotRef = useRef("")

  const loadMessages = useCallback(async (cwd: string, sessionId: string) => {
    setMessagesLoading(true)
    try {
      const result = await postJson<{ messages: SessionMessage[]; toolStats?: ToolStat[] }>(
        "/sessions/messages",
        { cwd, sessionId, limit: 30 }
      )
      const msgs = result.messages ?? []
      knownKeysRef.current = new Set(msgs.map(msgKey))
      messagesPrevSnapshotRef.current = JSON.stringify(msgs)
      setNewMessageKeys(new Set())
      setSessionMessages(msgs)
      setSessionToolStats(result.toolStats ?? [])
      setSelectedProjectCwd(cwd)
      setSelectedSessionId(sessionId)
      setQueryParams({ project: cwd, session: sessionId })
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
      const project = projects.find((p) => p.cwd === cwd)
      const firstSession = project?.sessions[0]
      if (firstSession) {
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
      projects,
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

  useEffect(() => {
    async function refresh() {
      try {
        const [m, cs, w, pr] = await Promise.all([
          fetchJson<MetricsResponse>("/metrics"),
          fetchJson<Record<string, number>>("/cache/status"),
          fetchJson<WatchesResponse>("/ci-watches"),
          postJson<{ projects: ProjectSessions[] }>("/sessions/projects", {
            limitProjects: 10,
            limitSessionsPerProject: 10,
            selectedProjectCwd: getQueryParam("project"),
            selectedSessionId: getQueryParam("session"),
          }),
        ])
        const snapshot = JSON.stringify({ m, cs, w, pr })
        if (snapshot === prevSnapshotRef.current) return
        prevSnapshotRef.current = snapshot

        setMetrics(m)
        setCacheStatus(cs)
        setWatches(w)
        const loadedProjects = pr.projects ?? []
        setProjects(loadedProjects)
        setError("")
        setLastUpdated(new Date().toLocaleTimeString())

        if (!initialLoadDone.current && loadedProjects.length > 0) {
          initialLoadDone.current = true
          const paramProject = getQueryParam("project")
          const paramSession = getQueryParam("session")
          if (paramProject && paramSession) {
            const match = loadedProjects.find((p) => p.cwd === paramProject)
            if (match) {
              void loadMessages(paramProject, paramSession)
              void loadTasks(paramProject, paramSession)
              void loadProjectTasks(paramProject)
              return
            }
          }
          const newest = [...loadedProjects].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
          if (newest) {
            const newestSession = [...newest.sessions].sort((a, b) => b.mtime - a.mtime)[0]
            if (newestSession) {
              void loadMessages(newest.cwd, newestSession.id)
              void loadTasks(newest.cwd, newestSession.id)
              void loadProjectTasks(newest.cwd)
            } else {
              setSelectedProjectCwd(newest.cwd)
              void loadProjectTasks(newest.cwd)
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown fetch failure")
      }
    }

    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [loadMessages, loadTasks, loadProjectTasks])

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
  }, [selectedProjectCwd])

  useEffect(() => {
    if (!selectedProjectCwd || !selectedSessionId) return
    const cwd = selectedProjectCwd
    const sid = selectedSessionId

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
        let fresh = new Set<string>()
        if (snap !== messagesPrevSnapshotRef.current) {
          messagesPrevSnapshotRef.current = snap

          fresh = new Set<string>()
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i]!
            const key = msgKey(m, i)
            if (!knownKeysRef.current.has(key)) fresh.add(key)
          }
          knownKeysRef.current = new Set(msgs.map(msgKey))
          setNewMessageKeys(fresh)
          setSessionMessages(msgs)
          setSessionToolStats(messagesResult.toolStats ?? [])
          if (fresh.size > 0) {
            setTimeout(() => setNewMessageKeys(new Set()), 500)
          }
        }

        setSessionTasks(tasksResult.tasks ?? [])
        setSessionTaskSummary(tasksResult.summary ?? null)
        setProjectTasks(projectTasksResult.tasks ?? [])
        setProjectTaskSummary(projectTasksResult.summary ?? null)
      } catch {
        /* ignore polling errors */
      }
    }

    const id = setInterval(() => void pollSessionData(), 2000)
    return () => clearInterval(id)
  }, [selectedProjectCwd, selectedSessionId])

  const m = metrics ?? {}
  const projectCount = projects.filter(hasProjectMessages).length
  const watchCount = (watches?.active ?? []).length
  const activeProject = optimisticProjectCwd
    ? projects.find((project) => project.cwd === optimisticProjectCwd)
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
        projects={projects}
        selectedProjectCwd={optimisticProjectCwd}
        selectedSessionId={optimisticSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
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
