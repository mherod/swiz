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

export interface ToolCallSummary {
  name: string
  detail: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  timestamp: string | null
  text: string
  toolCalls?: ToolCallSummary[]
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

/* ── Navigation card: projects + sessions list ── */

interface SessionNavProps {
  projects: ProjectSessions[]
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onSelectProject: (cwd: string) => void
  onSelectSession: (cwd: string, sessionId: string) => void
}

export function SessionNav({
  projects,
  selectedProjectCwd,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
}: SessionNavProps) {
  const sortedProjects = [...projects].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  const selectedProject = sortedProjects.find((p) => p.cwd === selectedProjectCwd) ?? null
  const sortedSessions = selectedProject
    ? [...selectedProject.sessions].sort((a, b) => b.mtime - a.mtime)
    : null

  return (
    <nav className="card bento-nav">
      <h2 className="section-title">Projects</h2>
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
      <h2 className="section-title" style={{ marginTop: 8 }}>
        Sessions
      </h2>
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
          <li className="empty">Select a project.</li>
        )}
      </ul>
    </nav>
  )
}

/* ── Messages card ── */

interface MessagesProps {
  messages: SessionMessage[]
  loading: boolean
}

export function SessionMessages({ messages, loading }: MessagesProps) {
  const sorted = [...messages].sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  return (
    <section className="card bento-messages">
      <h2 className="section-title">Transcript</h2>
      {loading ? (
        <p className="empty">Loading...</p>
      ) : messages.length === 0 ? (
        <p className="empty">No messages for this session.</p>
      ) : (
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
                {message.text && <MessageBody text={message.text} />}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <ul className="tool-calls">
                    {message.toolCalls.map((tc) => (
                      <li key={`${tc.name}-${tc.detail}`} className="tool-call">
                        <span className="tool-name">{tc.name}</span>
                        {tc.detail && <span className="tool-detail">{tc.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
