export interface SessionPreview {
  id: string
  provider?: string
  format?: string
  mtime: number
}

export interface ProjectSessions {
  cwd: string
  name: string
  lastSeenAt: number
  sessionCount: number
  sessions: SessionPreview[]
}

export interface SessionMessage {
  role: "user" | "assistant"
  timestamp: string | null
  text: string
}

interface SessionBrowserProps {
  projects: ProjectSessions[]
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  messages: SessionMessage[]
  messagesLoading: boolean
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
}

function renderProject(project: ProjectSessions, selectedProjectCwd: string | null): string {
  const selected = project.cwd === selectedProjectCwd
  const selectedAttr = selected ? "true" : "false"
  return `
    <li>
      <button
        type="button"
        class="project-btn ${selected ? "selected" : ""}"
        data-project-cwd="${escapeHtml(project.cwd)}"
        aria-pressed="${selectedAttr}"
      >
        <span class="project-name">${escapeHtml(project.name)}</span>
        <span class="project-meta">${project.sessionCount} sessions</span>
      </button>
    </li>
  `
}

function renderSession(
  session: SessionPreview,
  selectedSessionId: string | null,
  projectCwd: string
): string {
  const selected = session.id === selectedSessionId
  const selectedAttr = selected ? "true" : "false"
  const provider = session.provider ?? "unknown"
  return `
    <li>
      <button
        type="button"
        class="session-btn ${selected ? "selected" : ""}"
        data-project-cwd="${escapeHtml(projectCwd)}"
        data-session-id="${escapeHtml(session.id)}"
        aria-pressed="${selectedAttr}"
      >
        <span class="session-id">${escapeHtml(session.id)}</span>
        <span class="session-meta">${escapeHtml(provider)} • ${formatTime(session.mtime)}</span>
      </button>
    </li>
  `
}

function renderMessages(messages: SessionMessage[]): string {
  if (messages.length === 0) {
    return `<p class="empty">No transcript messages found for this session.</p>`
  }
  return `
    <ul class="messages-list" aria-label="Last 30 transcript messages">
      ${messages
        .map((message) => {
          const role = message.role === "assistant" ? "Assistant" : "User"
          const timestamp = message.timestamp
            ? formatTime(new Date(message.timestamp).getTime())
            : "Unknown time"
          return `
          <li class="message-row ${message.role}">
            <div class="message-meta">
              <span class="message-role">${role}</span>
              <span>${timestamp}</span>
            </div>
            <pre class="message-text">${escapeHtml(message.text)}</pre>
          </li>
        `
        })
        .join("")}
    </ul>
  `
}

export function SessionBrowser({
  projects,
  selectedProjectCwd,
  selectedSessionId,
  messages,
  messagesLoading,
}: SessionBrowserProps): string {
  const selectedProject = projects.find((project) => project.cwd === selectedProjectCwd) ?? null
  return `
    <section class="card section sessions-panel">
      <div class="section-title-row">
        <h2>Projects & Sessions</h2>
        <span class="section-subtitle">Browse active/recent directories and transcript history</span>
      </div>
      <div class="sessions-layout">
        <aside class="sessions-sidebar">
          <h3>Projects</h3>
          <ul class="project-list" aria-label="Active and recent project directories">
            ${projects.map((project) => renderProject(project, selectedProjectCwd)).join("")}
          </ul>
          <h3>Sessions</h3>
          <ul class="session-list" aria-label="Sessions for selected project">
            ${
              selectedProject
                ? selectedProject.sessions
                    .map((session) =>
                      renderSession(session, selectedSessionId, selectedProject.cwd)
                    )
                    .join("")
                : `<li class="empty">Select a project to see sessions.</li>`
            }
          </ul>
        </aside>
        <div class="sessions-messages" aria-live="polite" aria-busy="${messagesLoading ? "true" : "false"}">
          <h3>Last 30 messages</h3>
          ${messagesLoading ? `<p class="empty">Loading messages...</p>` : renderMessages(messages)}
        </div>
      </div>
    </section>
  `
}
