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
  onSelectProject: (cwd: string, sessionId?: string) => void
  onSelectSession: (cwd: string, sessionId: string) => void
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
}

const COLLAPSE_LINE_THRESHOLD = 20

function MessageBody({ text }: { text: string }) {
  const lines = text.split("\n")
  if (lines.length <= COLLAPSE_LINE_THRESHOLD) {
    return <pre className="message-text">{text}</pre>
  }
  const preview = lines.slice(0, COLLAPSE_LINE_THRESHOLD).join("\n")
  const remaining = lines.length - COLLAPSE_LINE_THRESHOLD
  return (
    <details className="message-collapsible">
      <summary>
        <pre className="message-text">{preview}</pre>
        <span className="message-expand-hint">{remaining} more lines</span>
      </summary>
      <pre className="message-text">{text}</pre>
    </details>
  )
}

function MessageList({ messages }: { messages: SessionMessage[] }) {
  if (messages.length === 0) {
    return <p className="empty">No transcript messages found for this session.</p>
  }
  const sorted = [...messages].sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })
  return (
    <ul className="messages-list" aria-label="Last 30 transcript messages">
      {sorted.map((message, i) => {
        const role = message.role === "assistant" ? "Assistant" : "User"
        const timestamp = message.timestamp
          ? formatTime(new Date(message.timestamp).getTime())
          : "Unknown time"
        return (
          <li key={`${message.timestamp}-${i}`} className={`message-row ${message.role}`}>
            <div className="message-meta">
              <span className="message-role">{role}</span>
              <span>{timestamp}</span>
            </div>
            <MessageBody text={message.text} />
          </li>
        )
      })}
    </ul>
  )
}

export function SessionBrowser({
  projects,
  selectedProjectCwd,
  selectedSessionId,
  messages,
  messagesLoading,
  onSelectProject,
  onSelectSession,
}: SessionBrowserProps) {
  const sortedProjects = [...projects].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  const selectedProject =
    sortedProjects.find((project) => project.cwd === selectedProjectCwd) ?? null
  const sortedSessions = selectedProject
    ? [...selectedProject.sessions].sort((a, b) => b.mtime - a.mtime)
    : null

  return (
    <section className="card sessions-panel">
      <h2 className="section-title">Sessions</h2>
      <div className="sessions-layout">
        <aside className="sessions-sidebar">
          <h3>Projects</h3>
          <ul className="project-list" aria-label="Active and recent project directories">
            {sortedProjects.map((project) => (
              <li key={project.cwd}>
                <button
                  type="button"
                  className={`project-btn ${project.cwd === selectedProjectCwd ? "selected" : ""}`}
                  aria-pressed={project.cwd === selectedProjectCwd}
                  onClick={() => onSelectProject(project.cwd)}
                >
                  <span className="project-name">{project.name}</span>
                  <span className="project-meta">{project.sessionCount} sessions</span>
                </button>
              </li>
            ))}
          </ul>
          <h3>Sessions</h3>
          <ul className="session-list" aria-label="Sessions for selected project">
            {sortedSessions ? (
              sortedSessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`session-btn ${session.id === selectedSessionId ? "selected" : ""}`}
                    aria-pressed={session.id === selectedSessionId}
                    onClick={() => onSelectSession(selectedProject!.cwd, session.id)}
                  >
                    <span className="session-id">{session.id}</span>
                    <span className="session-meta">
                      {session.provider ?? "unknown"} &bull; {formatTime(session.mtime)}
                    </span>
                  </button>
                </li>
              ))
            ) : (
              <li className="empty">Select a project to see sessions.</li>
            )}
          </ul>
        </aside>
        <div className="sessions-messages" aria-live="polite" aria-busy={messagesLoading}>
          <h3>Last 30 messages</h3>
          {messagesLoading ? (
            <p className="empty">Loading messages...</p>
          ) : (
            <MessageList messages={messages} />
          )}
        </div>
      </div>
    </section>
  )
}
