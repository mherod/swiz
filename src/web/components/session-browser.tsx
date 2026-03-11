export interface SessionPreview {
  id: string
  provider?: string
  format?: string
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
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

export interface SessionTask {
  id: string
  subject: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  statusChangedAt: string | null
  completionTimestamp: string | null
  completionEvidence: string | null
}

export interface SessionTaskSummary {
  total: number
  open: number
  completed: number
  cancelled: number
}

interface GroupedSessionMessage {
  message: SessionMessage
  count: number
  originalIndices: number[]
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatCompactTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatRelativeTime(ts: number): string {
  const deltaMs = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (deltaMs < minute) return "just now"
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}m ago`
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}h ago`
  return `${Math.floor(deltaMs / day)}d ago`
}

function shortSessionId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}...${id.slice(-4)}`
}

import { Markdown } from "./markdown.tsx"

const COLLAPSE_LINE_THRESHOLD = 20
const COLLAPSE_CHAR_THRESHOLD = 900

function summarizeText(text: string): string {
  if (text.length <= COLLAPSE_CHAR_THRESHOLD) return text
  const candidate = text.slice(0, COLLAPSE_CHAR_THRESHOLD)
  const cutIndex = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"))
  return `${candidate.slice(0, cutIndex > 0 ? cutIndex : candidate.length).trimEnd()}…`
}

function isMarkdownLike(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*]\s|>\s|```)|`[^`]+`|\[[^\]]+\]\([^)]+\)/m.test(text)
}

function looksLikeLogBlob(text: string): boolean {
  const hasErrorWords = /(error|exception|stack|trace|invalid|failed)/i.test(text)
  const hasSignatureNoise = /[{}[\]():;]/.test(text)
  const lines = text.split("\n").length
  return hasErrorWords && hasSignatureNoise && (lines > 8 || text.length > 420)
}

function normalizeAssistantText(text: string): string {
  if (isMarkdownLike(text)) return text
  if (text.length < 300) return text
  const newlineCount = (text.match(/\n/g) ?? []).length
  if (newlineCount > 8) return text
  return text
    .replace(/\. (?=[A-Z][a-z]{2,}\b)/g, ".\n\n")
    .replace(/\) (?=[A-Z][a-z]{2,}\b)/g, ")\n\n")
    .replace(/: (?=[A-Z][a-z]{2,}\b)/g, ":\n")
}

interface AssistantMessageParts {
  visibleText: string
  thoughtText: string | null
}

function splitAssistantMessage(text: string): AssistantMessageParts {
  const thoughts: string[] = []
  const visibleText = text
    .replace(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi, (_, inner: string) => {
      const cleaned = inner.trim()
      if (cleaned) thoughts.push(cleaned)
      return ""
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  const thoughtText = thoughts.join("\n\n").trim()
  return {
    visibleText,
    thoughtText: thoughtText.length > 0 ? thoughtText : null,
  }
}

function tryParseJson(text: string): string | null {
  const candidate = text.trim()
  if (!(candidate.startsWith("{") || candidate.startsWith("["))) return null
  try {
    const parsed = JSON.parse(candidate)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function normalizeInlineFencedCode(text: string): string {
  if (!text.includes("```")) return text
  const normalized = text.replace(
    /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g,
    (_match: string, lang: string, code: string) => `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`
  )
  return normalized.replace(/\n{3,}/g, "\n\n").trim()
}

function formatAssistantJsonBlocks(text: string): string {
  if (!text) return text
  const withNormalizedFences = normalizeInlineFencedCode(text)
  if (withNormalizedFences.includes("```")) return withNormalizedFences

  const wholeJson = tryParseJson(withNormalizedFences)
  if (wholeJson) return `\`\`\`json\n${wholeJson}\n\`\`\``

  // Common case: prose prefix followed by a JSON payload (for example API errors).
  const firstBrace = withNormalizedFences.indexOf("{")
  const firstBracket = withNormalizedFences.indexOf("[")
  const startCandidates = [firstBrace, firstBracket].filter((idx) => idx >= 0)
  if (startCandidates.length === 0) return withNormalizedFences
  const start = Math.min(...startCandidates)

  const jsonLike = withNormalizedFences.slice(start).trim()
  const parsed = tryParseJson(jsonLike)
  if (!parsed) return withNormalizedFences

  const prefix = withNormalizedFences.slice(0, start).trimEnd()
  if (!prefix) return `\`\`\`json\n${parsed}\n\`\`\``
  return `${prefix}\n\n\`\`\`json\n${parsed}\n\`\`\``
}

function canonicalGroupKey(message: SessionMessage): string {
  if (message.role !== "assistant") return `${message.role}|${message.text}`
  const normalized = message.text
    .replace(/after\s+\d+h\d+m\d+s\.?/gi, "after <duration>")
    .replace(/\b\d+m\d+s\b/gi, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
  return `${message.role}|${normalized}`
}

function groupMessages(messages: SessionMessage[]): GroupedSessionMessage[] {
  const grouped: GroupedSessionMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!
    const last = grouped[grouped.length - 1]
    if (last && canonicalGroupKey(last.message) === canonicalGroupKey(current)) {
      last.count += 1
      last.originalIndices.push(i)
      continue
    }
    grouped.push({
      message: current,
      count: 1,
      originalIndices: [i],
    })
  }
  return grouped
}

function MessageBody({ text, role }: { text: string; role: "user" | "assistant" }) {
  const assistantParts = role === "assistant" ? splitAssistantMessage(text) : null
  const assistantVisible = assistantParts?.visibleText ?? text
  const assistantWithJson =
    role === "assistant" ? formatAssistantJsonBlocks(assistantVisible) : text
  const preparedText = role === "assistant" ? normalizeAssistantText(assistantWithJson) : text
  const lines = preparedText.split("\n")
  const shouldCollapse =
    lines.length > COLLAPSE_LINE_THRESHOLD || preparedText.length > COLLAPSE_CHAR_THRESHOLD
  const hasCodeFence = preparedText.includes("```")
  const renderAsLog = role === "assistant" && !hasCodeFence && looksLikeLogBlob(preparedText)
  if (role === "assistant") {
    const thoughtText = assistantParts?.thoughtText
    if (!shouldCollapse || hasCodeFence) {
      return (
        <>
          {preparedText ? (
            renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )
          ) : null}
          {thoughtText ? (
            <details className="assistant-thought">
              <summary>Model reasoning</summary>
              <pre className="message-log assistant-thought-body">{thoughtText}</pre>
            </details>
          ) : null}
        </>
      )
    }
    const preview = summarizeText(preparedText)
    const remaining = Math.max(preparedText.length - preview.length, 0)
    return (
      <>
        {preparedText ? (
          <details className="message-collapsible">
            <summary>
              {renderAsLog ? (
                <pre className="message-log">{preview}</pre>
              ) : (
                <Markdown text={preview} />
              )}
              <span className="message-expand-hint">{remaining} more chars</span>
            </summary>
            {renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )}
          </details>
        ) : null}
        {thoughtText ? (
          <details className="assistant-thought">
            <summary>Model reasoning</summary>
            <pre className="message-log assistant-thought-body">{thoughtText}</pre>
          </details>
        ) : null}
      </>
    )
  }
  if (!shouldCollapse) {
    return <pre className="message-text">{text}</pre>
  }
  const preview = summarizeText(text)
  const remaining = Math.max(text.length - preview.length, 0)
  return (
    <details className="message-collapsible">
      <summary>
        <pre className="message-text">{preview}</pre>
        <span className="message-expand-hint">{remaining} more chars</span>
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
    ? [...selectedProject.sessions].sort((a, b) => {
        const aDisp = a.dispatches ?? 0
        const bDisp = b.dispatches ?? 0
        if (aDisp > 0 && bDisp === 0) return -1
        if (bDisp > 0 && aDisp === 0) return 1
        return (b.lastMessageAt ?? b.mtime) - (a.lastMessageAt ?? a.mtime)
      })
    : null
  const activeThresholdMs = 30 * 60 * 1000
  const activeSessions = sortedSessions?.filter(
    (session) => Date.now() - (session.lastMessageAt ?? session.mtime) <= activeThresholdMs
  )
  const recentSessions = sortedSessions?.filter(
    (session) => Date.now() - (session.lastMessageAt ?? session.mtime) > activeThresholdMs
  )

  return (
    <nav className="card bento-nav">
      <h2 className="section-title">Projects</h2>
      <p className="section-subtitle">Project and session switcher</p>
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
      <h2 className="section-title nav-section-title">Sessions</h2>
      <ul className="session-list" aria-label="Sessions for selected project">
        {sortedSessions ? (
          <>
            {activeSessions && activeSessions.length > 0 ? (
              <li className="session-group-label">Active now</li>
            ) : null}
            {activeSessions?.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`session-btn ${session.id === selectedSessionId ? "selected" : ""}`}
                  aria-pressed={session.id === selectedSessionId}
                  onClick={() => onSelectSession(selectedProject!.cwd, session.id)}
                >
                  <span className="session-id" title={session.id}>
                    {(session.provider ?? "unknown").toLowerCase()} ·{" "}
                    {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
                    {session.dispatches ? (
                      <span className="session-dispatches">{session.dispatches}</span>
                    ) : null}
                  </span>
                  <span className="session-meta">
                    {shortSessionId(session.id)} ·{" "}
                    {formatCompactTime(session.lastMessageAt ?? session.mtime)}
                  </span>
                </button>
              </li>
            ))}
            {recentSessions && recentSessions.length > 0 ? (
              <li className="session-group-label">Recent</li>
            ) : null}
            {recentSessions?.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`session-btn ${session.id === selectedSessionId ? "selected" : ""}`}
                  aria-pressed={session.id === selectedSessionId}
                  onClick={() => onSelectSession(selectedProject!.cwd, session.id)}
                >
                  <span className="session-id" title={session.id}>
                    {(session.provider ?? "unknown").toLowerCase()} ·{" "}
                    {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
                    {session.dispatches ? (
                      <span className="session-dispatches">{session.dispatches}</span>
                    ) : null}
                  </span>
                  <span className="session-meta">
                    {shortSessionId(session.id)} ·{" "}
                    {formatCompactTime(session.lastMessageAt ?? session.mtime)}
                  </span>
                </button>
              </li>
            ))}
          </>
        ) : (
          <li className="empty">Select a project.</li>
        )}
      </ul>
    </nav>
  )
}

/* ── Tool stats bar ── */

export interface ToolStat {
  name: string
  count: number
}

function ToolStatsBar({ stats }: { stats: ToolStat[] }) {
  if (stats.length === 0) return null
  const total = stats.reduce((sum, s) => sum + s.count, 0)
  return (
    <div className="tool-stats-bar">
      <span className="tool-stats-total">{total} tool calls</span>
      <div className="tool-stats-pills">
        {stats.slice(0, 8).map((s) => (
          <span key={s.name} className="tool-stat-pill">
            <span className="tool-stat-name">{s.name}</span>
            <span className="tool-stat-count">{s.count}</span>
          </span>
        ))}
        {stats.length > 8 && (
          <span className="tool-stat-pill tool-stat-more">+{stats.length - 8} more</span>
        )}
      </div>
    </div>
  )
}

/* ── Messages card ── */

interface MessagesProps {
  messages: SessionMessage[]
  loading: boolean
  newKeys?: Set<string>
  msgKey?: (msg: SessionMessage, i: number) => string
  toolStats?: ToolStat[]
  tasks?: SessionTask[]
  taskSummary?: SessionTaskSummary | null
  tasksLoading?: boolean
}

function TaskStatusBadge({ status }: { status: SessionTask["status"] }) {
  const label = status.replace("_", " ")
  return <span className={`task-status task-status-${status}`}>{label}</span>
}

function SessionTasksSection({
  tasks,
  summary,
  loading,
}: {
  tasks: SessionTask[]
  summary: SessionTaskSummary | null
  loading: boolean
}) {
  return (
    <section className="session-tasks-section" aria-label="Current tasks for selected session">
      <h3 className="session-tasks-title">Session tasks</h3>
      {summary ? (
        <p className="session-tasks-summary">
          {summary.open} open · {summary.completed} completed · {summary.cancelled} cancelled
        </p>
      ) : null}
      {loading ? (
        <p className="empty">Loading tasks...</p>
      ) : tasks.length === 0 ? (
        <p className="empty">No tasks recorded for this session.</p>
      ) : (
        <ul className="session-task-list">
          {tasks.map((task) => {
            const taskTime = task.statusChangedAt ?? task.completionTimestamp
            return (
              <li key={task.id} className="session-task-row">
                <div className="session-task-meta">
                  <span className="session-task-id">#{task.id}</span>
                  <TaskStatusBadge status={task.status} />
                </div>
                <p className="session-task-subject">{task.subject}</p>
                {taskTime ? (
                  <p className="session-task-time">{formatTime(new Date(taskTime).getTime())}</p>
                ) : null}
                {task.completionEvidence ? (
                  <p className="session-task-evidence">{task.completionEvidence}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function SessionMessages({
  messages,
  loading,
  newKeys,
  msgKey,
  toolStats,
  tasks = [],
  taskSummary = null,
  tasksLoading = false,
}: MessagesProps) {
  const sorted = [...messages].sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })
  const grouped = groupMessages(sorted)

  return (
    <section className="card bento-messages">
      <h2 className="section-title">Transcript</h2>
      <p className="section-subtitle">Conversation history for selected session</p>
      <SessionTasksSection tasks={tasks} summary={taskSummary} loading={tasksLoading} />
      {toolStats && toolStats.length > 0 && <ToolStatsBar stats={toolStats} />}
      {loading ? (
        <p className="empty">Loading...</p>
      ) : messages.length === 0 ? (
        <p className="empty">No messages for this session.</p>
      ) : (
        <ul className="messages-list" aria-label="Last 30 transcript messages">
          {grouped.map(({ message, count, originalIndices }, i) => {
            const role = message.role === "assistant" ? "Assistant" : "User"
            const timestamp = message.timestamp
              ? formatTime(new Date(message.timestamp).getTime())
              : "Unknown time"
            const groupKeys = msgKey
              ? originalIndices.map((idx) => msgKey(sorted[idx]!, idx))
              : [`${message.timestamp}-${i}`]
            const key = groupKeys[0]!
            const isNew = groupKeys.some((groupKey) => newKeys?.has(groupKey) ?? false)
            return (
              <li key={key} className={`message-row ${message.role}${isNew ? " message-new" : ""}`}>
                <div className="message-meta">
                  <span className="message-role">{role}</span>
                  <span className="message-meta-right">
                    {count > 1 ? <span className="message-repeat-badge">x{count}</span> : null}
                    <span>{timestamp}</span>
                  </span>
                </div>
                {message.text && <MessageBody text={message.text} role={message.role} />}
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
