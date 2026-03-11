import { CacheList } from "./components/cache-list.tsx"
import { EventTable } from "./components/event-table.tsx"
import { Header } from "./components/header.tsx"
import {
  type ProjectSessions,
  SessionBrowser,
  type SessionMessage,
} from "./components/session-browser.tsx"
import { StatGrid } from "./components/stat-grid.tsx"

interface MetricsResponse {
  uptimeHuman?: string
  totalDispatches?: number
  byEvent?: Record<string, { count?: number; avgMs?: number }>
  projects?: Record<string, unknown>
}

interface WatchesResponse {
  active?: unknown[]
}

interface AppState {
  metrics: MetricsResponse | null
  cacheStatus: Record<string, number> | null
  watches: WatchesResponse | null
  projects: ProjectSessions[]
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  sessionMessages: SessionMessage[]
  messagesLoading: boolean
  error: string
  lastUpdated: string
}

const app = document.querySelector<HTMLElement>("#app")
let lastRenderedHtml = ""

const state: AppState = {
  metrics: null,
  cacheStatus: null,
  watches: null,
  projects: [],
  selectedProjectCwd: null,
  selectedSessionId: null,
  sessionMessages: [],
  messagesLoading: false,
  error: "",
  lastUpdated: "starting",
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  return (await response.json()) as T
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

async function loadSessionMessages(cwd: string, sessionId: string): Promise<void> {
  state.messagesLoading = true
  render()
  try {
    const result = await postJson<{ messages: SessionMessage[] }>("/sessions/messages", {
      cwd,
      sessionId,
      limit: 30,
    })
    state.sessionMessages = result.messages ?? []
    state.selectedProjectCwd = cwd
    state.selectedSessionId = sessionId
  } finally {
    state.messagesLoading = false
    render()
  }
}

function syncProjectSelection(
  projects: ProjectSessions[]
): { shouldLoad: boolean; cwd: string; sessionId: string } | null {
  if (projects.length === 0) {
    state.selectedProjectCwd = null
    state.selectedSessionId = null
    state.sessionMessages = []
    return null
  }

  const selectedProject =
    projects.find((project) => project.cwd === state.selectedProjectCwd) ?? projects[0] ?? null
  if (!selectedProject) return null

  const selectedSession =
    selectedProject.sessions.find((session) => session.id === state.selectedSessionId) ??
    selectedProject.sessions[0] ??
    null
  if (!selectedSession) {
    state.selectedProjectCwd = selectedProject.cwd
    state.selectedSessionId = null
    state.sessionMessages = []
    return null
  }

  const shouldLoad =
    state.selectedProjectCwd !== selectedProject.cwd ||
    state.selectedSessionId !== selectedSession.id
  state.selectedProjectCwd = selectedProject.cwd
  state.selectedSessionId = selectedSession.id
  return shouldLoad ? { shouldLoad, cwd: selectedProject.cwd, sessionId: selectedSession.id } : null
}

function render(): void {
  if (!app) return

  let html: string
  if (state.error) {
    html = `
      ${Header({
        lastUpdated: state.lastUpdated,
        uptime: "unknown",
        totalDispatches: 0,
      })}
      <section class="card error" role="alert" aria-live="assertive">
        <h2>Frontend error</h2>
        <p>${state.error}</p>
      </section>
    `
  } else {
    const metrics = state.metrics ?? {}
    const projects = Object.keys(metrics.projects ?? {}).length
    const watches = (state.watches?.active ?? []).length

    html = `
      <p class="sr-only" aria-live="polite" aria-atomic="true">
        Dashboard updated at ${state.lastUpdated}.
      </p>
      ${Header({
        lastUpdated: state.lastUpdated,
        uptime: metrics.uptimeHuman ?? "starting",
        totalDispatches: metrics.totalDispatches ?? 0,
      })}
      ${StatGrid({
        uptime: metrics.uptimeHuman ?? "starting",
        totalDispatches: metrics.totalDispatches ?? 0,
        projects,
        activeWatches: watches,
      })}
      <section class="grid">
        ${EventTable(toSortedEvents(metrics.byEvent))}
        ${CacheList(state.cacheStatus ?? {})}
      </section>
      ${SessionBrowser({
        projects: state.projects,
        selectedProjectCwd: state.selectedProjectCwd,
        selectedSessionId: state.selectedSessionId,
        messages: state.sessionMessages,
        messagesLoading: state.messagesLoading,
      })}
    `
  }

  if (html === lastRenderedHtml) return
  lastRenderedHtml = html
  const isFirstRender = !app.hasChildNodes()
  app.innerHTML = html
  if (!isFirstRender) {
    app.style.animation = "none"
    for (const child of Array.from(app.children) as HTMLElement[]) {
      child.style.animation = "none"
    }
  }
}

function stateSnapshot(): string {
  return JSON.stringify({
    m: state.metrics,
    c: state.cacheStatus,
    w: state.watches,
    p: state.projects,
    e: state.error,
    sp: state.selectedProjectCwd,
    ss: state.selectedSessionId,
    sm: state.sessionMessages,
    ml: state.messagesLoading,
  })
}

async function refresh(): Promise<void> {
  const before = stateSnapshot()
  try {
    const [metrics, cacheStatus, watches, projectsResponse] = await Promise.all([
      fetchJson<MetricsResponse>("/metrics"),
      fetchJson<Record<string, number>>("/cache/status"),
      fetchJson<WatchesResponse>("/ci-watches"),
      postJson<{ projects: ProjectSessions[] }>("/sessions/projects", {
        limitProjects: 10,
        limitSessionsPerProject: 10,
      }),
    ])
    state.metrics = metrics
    state.cacheStatus = cacheStatus
    state.watches = watches
    state.projects = projectsResponse.projects ?? []
    state.error = ""
    const nextSelection = syncProjectSelection(state.projects)
    if (nextSelection) {
      await loadSessionMessages(nextSelection.cwd, nextSelection.sessionId)
      return
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Unknown fetch failure"
  }
  if (stateSnapshot() !== before) {
    state.lastUpdated = new Date().toLocaleTimeString()
    render()
  }
}

if (app) {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    const sessionButton = target.closest<HTMLButtonElement>("[data-session-id]")
    if (sessionButton) {
      const cwd = sessionButton.dataset.projectCwd
      const sessionId = sessionButton.dataset.sessionId
      if (cwd && sessionId) {
        void loadSessionMessages(cwd, sessionId)
      }
      return
    }

    const projectButton = target.closest<HTMLButtonElement>("[data-project-cwd]")
    if (projectButton && !projectButton.dataset.sessionId) {
      const cwd = projectButton.dataset.projectCwd
      if (!cwd) return
      const project = state.projects.find((item) => item.cwd === cwd)
      const firstSession = project?.sessions[0]
      if (firstSession) {
        void loadSessionMessages(cwd, firstSession.id)
      } else {
        state.selectedProjectCwd = cwd
        state.selectedSessionId = null
        state.sessionMessages = []
        render()
      }
    }
  })
}

render()
await refresh()
setInterval(() => {
  void refresh()
}, 5000)
