import { useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { CacheList } from "./components/cache-list.tsx"
import { EventTable } from "./components/event-table.tsx"
import { Header } from "./components/header.tsx"
import {
  type ProjectSessions,
  SessionBrowser,
  type SessionMessage,
} from "./components/session-browser.tsx"

interface MetricsResponse {
  uptimeHuman?: string
  totalDispatches?: number
  byEvent?: Record<string, { count?: number; avgMs?: number }>
  projects?: Record<string, unknown>
}

interface WatchesResponse {
  active?: unknown[]
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  return (await response.json()) as T
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

function toSortedEvents(
  byEvent: MetricsResponse["byEvent"]
): Array<{ name: string; count: number; avgMs: number }> {
  return Object.entries(byEvent ?? {})
    .map(([name, data]) => ({
      name,
      count: data.count ?? 0,
      avgMs: data.avgMs ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
}

function App() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [cacheStatus, setCacheStatus] = useState<Record<string, number> | null>(null)
  const [watches, setWatches] = useState<WatchesResponse | null>(null)
  const [projects, setProjects] = useState<ProjectSessions[]>([])
  const [selectedProjectCwd, setSelectedProjectCwd] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [error, setError] = useState("")
  const [lastUpdated, setLastUpdated] = useState("starting")
  const prevSnapshotRef = useRef("")

  const loadMessages = useCallback(async (cwd: string, sessionId: string) => {
    setMessagesLoading(true)
    setSelectedProjectCwd(cwd)
    setSelectedSessionId(sessionId)
    try {
      const result = await postJson<{ messages: SessionMessage[] }>("/sessions/messages", {
        cwd,
        sessionId,
        limit: 30,
      })
      setSessionMessages(result.messages ?? [])
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
        setProjects(pr.projects ?? [])
        setError("")
        setLastUpdated(new Date().toLocaleTimeString())
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown fetch failure")
      }
    }

    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [])

  const m = metrics ?? {}
  const projectCount = Object.keys(m.projects ?? {}).length
  const watchCount = (watches?.active ?? []).length

  if (error) {
    return (
      <>
        <Header
          lastUpdated={lastUpdated}
          uptime="unknown"
          totalDispatches={0}
          projects={0}
          activeWatches={0}
        />
        <section className="card error" role="alert" aria-live="assertive">
          <h2>Frontend error</h2>
          <p>{error}</p>
        </section>
      </>
    )
  }

  return (
    <>
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
      <div className="main-columns">
        <EventTable events={toSortedEvents(m.byEvent)} />
        <CacheList cache={cacheStatus ?? {}} />
        <SessionBrowser
          projects={projects}
          selectedProjectCwd={selectedProjectCwd}
          selectedSessionId={selectedSessionId}
          messages={sessionMessages}
          messagesLoading={messagesLoading}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
        />
      </div>
    </>
  )
}

const root = createRoot(document.getElementById("app")!)
root.render(<App />)
