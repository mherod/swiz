import { useCallback, useEffect, useRef, useState } from "react"
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
  type SessionMessage,
  SessionMessages,
  SessionNav,
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
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([])
  const [sessionToolStats, setSessionToolStats] = useState<ToolStat[]>([])
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
    setSelectedProjectCwd(cwd)
    setSelectedSessionId(sessionId)
    setQueryParams({ project: cwd, session: sessionId })
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
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const handleSelectProject = useCallback(
    (cwd: string) => {
      setSelectedProjectCwd(cwd)
      const project = projects.find((p) => p.cwd === cwd)
      const firstSession = project?.sessions[0]
      if (firstSession) {
        void loadMessages(cwd, firstSession.id)
      } else {
        setSelectedSessionId(null)
        setSessionMessages([])
        setQueryParams({ project: cwd, session: null })
      }
    },
    [projects, loadMessages]
  )

  const handleSelectSession = useCallback(
    (cwd: string, sessionId: string) => {
      void loadMessages(cwd, sessionId)
    },
    [loadMessages]
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
              return
            }
          }
          const newest = [...loadedProjects].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
          if (newest) {
            const newestSession = [...newest.sessions].sort((a, b) => b.mtime - a.mtime)[0]
            if (newestSession) {
              void loadMessages(newest.cwd, newestSession.id)
            } else {
              setSelectedProjectCwd(newest.cwd)
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
  }, [loadMessages])

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

    async function pollMessages() {
      try {
        const result = await postJson<{ messages: SessionMessage[]; toolStats?: ToolStat[] }>(
          "/sessions/messages",
          { cwd, sessionId: sid, limit: 30 }
        )
        const msgs = result.messages ?? []
        const snap = JSON.stringify(msgs)
        if (snap === messagesPrevSnapshotRef.current) return
        messagesPrevSnapshotRef.current = snap

        const fresh = new Set<string>()
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]!
          const key = msgKey(m, i)
          if (!knownKeysRef.current.has(key)) fresh.add(key)
        }
        knownKeysRef.current = new Set(msgs.map(msgKey))
        setNewMessageKeys(fresh)
        setSessionMessages(msgs)
        setSessionToolStats(result.toolStats ?? [])
        if (fresh.size > 0) {
          setTimeout(() => setNewMessageKeys(new Set()), 500)
        }
      } catch {
        /* ignore polling errors */
      }
    }

    const id = setInterval(() => void pollMessages(), 2000)
    return () => clearInterval(id)
  }, [selectedProjectCwd, selectedSessionId])

  const m = metrics ?? {}
  const projectCount = projects.filter(hasProjectMessages).length
  const watchCount = (watches?.active ?? []).length
  const activeProject = selectedProjectCwd
    ? projects.find((project) => project.cwd === selectedProjectCwd)
    : null
  const activeSession = selectedSessionId
    ? (activeProject?.sessions.find((session) => session.id === selectedSessionId) ?? null)
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
        selectedProjectCwd={selectedProjectCwd}
        selectedSessionId={selectedSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
      />
      <SessionMessages
        messages={sessionMessages}
        loading={messagesLoading}
        newKeys={newMessageKeys}
        msgKey={msgKey}
        toolStats={sessionToolStats}
      />
      <MetricsRail
        events={projectEvents.length > 0 ? projectEvents : toSortedEvents(m.byEvent)}
        scope={selectedProjectCwd ? "project" : "global"}
        cacheStatus={cacheStatus}
        activeSession={activeSession}
        loadedMessageCount={sessionMessages.length}
        sessionToolStats={sessionToolStats}
      />
    </div>
  )
}
