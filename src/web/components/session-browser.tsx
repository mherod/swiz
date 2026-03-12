import { type ReactNode, useMemo, useState } from "react"
import { cn } from "../lib/cn.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import {
  formatAssistantJsonBlocks,
  normalizeAssistantText,
  splitAssistantMessage,
  splitUserMessage,
} from "../lib/message-format.ts"
import { Markdown, renderInline } from "./markdown.tsx"

export interface SessionPreview {
  id: string
  provider?: string
  format?: string
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
  activeDispatch?: ActiveHookDispatch
}

export interface ProjectSessions {
  cwd: string
  name: string
  lastSeenAt: number
  sessionCount: number
  sessions: SessionPreview[]
  statusLine?: string
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

export interface ProjectTask extends SessionTask {
  sessionId: string
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

type ProjectStateLabel = "planning" | "developing" | "reviewing" | "addressing-feedback"

function extractProjectState(statusLine?: string): ProjectStateLabel | null {
  if (!statusLine) return null
  const match = statusLine.match(
    /\bstate:\s*(planning|developing|reviewing|addressing-feedback)\b/i
  )
  return (match?.[1]?.toLowerCase() as ProjectStateLabel | undefined) ?? null
}

function formatProjectStateLabel(state: ProjectStateLabel): string {
  return state === "addressing-feedback" ? "addressing feedback" : state
}

type StatusChipTone = "neutral" | "info" | "warn" | "success" | "state"

interface ParsedStatusToken {
  label: string
  tone: StatusChipTone
}

function parseProjectStatusLine(statusLine?: string): ParsedStatusToken[] {
  if (!statusLine) return []
  const parts = statusLine
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
  const parsed: ParsedStatusToken[] = parts.map((part): ParsedStatusToken => {
    const lower = part.toLowerCase()
    if (lower.startsWith("state:")) return { label: part.replace(/^state:\s*/i, ""), tone: "state" }
    if (lower.includes("changes requested")) return { label: part, tone: "warn" }
    if (lower.includes("approved")) return { label: part, tone: "success" }
    if (/\b\d+\s+issues?\b/.test(lower) || /\b\d+\s+prs?\b/.test(lower)) {
      return { label: part, tone: "info" }
    }
    return { label: part, tone: "neutral" }
  })
  return parsed.filter((token) => {
    if (token.tone !== "neutral") return true
    // Drop dense git shorthand tokens like "± main ~10 ?1 $3".
    if (/[±~?$]/.test(token.label)) return false
    return token.label.length <= 32
  })
}

function providerProcessPids(
  provider: string | undefined,
  activeAgentPidsByProvider: Record<string, number[]>
): number[] {
  const key = (provider ?? "unknown").toLowerCase()
  return activeAgentPidsByProvider[key] ?? []
}

function formatProcessPidLabel(pids: number[]): string {
  if (pids.length <= 2) return pids.join(",")
  return `${pids.slice(0, 2).join(",")} +${pids.length - 2}`
}

function mergeSessionPreview(base: SessionPreview, incoming: SessionPreview): SessionPreview {
  return {
    ...base,
    provider: base.provider || incoming.provider,
    format: base.format || incoming.format,
    startedAt:
      typeof base.startedAt === "number" && typeof incoming.startedAt === "number"
        ? Math.min(base.startedAt, incoming.startedAt)
        : (base.startedAt ?? incoming.startedAt),
    lastMessageAt: Math.max(base.lastMessageAt ?? 0, incoming.lastMessageAt ?? 0) || undefined,
    mtime: Math.max(base.mtime, incoming.mtime),
    dispatches: Math.max(base.dispatches ?? 0, incoming.dispatches ?? 0) || undefined,
  }
}

function dedupeSessionsById(sessions: SessionPreview[]): SessionPreview[] {
  const byId = new Map<string, SessionPreview>()
  for (const session of sessions) {
    const existing = byId.get(session.id)
    if (!existing) {
      byId.set(session.id, session)
      continue
    }
    byId.set(session.id, mergeSessionPreview(existing, session))
  }
  return [...byId.values()]
}

const COLLAPSE_LINE_THRESHOLD = 20
const COLLAPSE_CHAR_THRESHOLD = 900

function buildCollapseHint(text: string): string {
  const lineCount = text.split("\n").length
  const charCount = text.length
  const charLabel = charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : `${charCount}`
  return `Expand · ${lineCount} lines · ${charLabel} chars`
}

function summarizeText(text: string): string {
  if (text.length <= COLLAPSE_CHAR_THRESHOLD) return text
  const candidate = text.slice(0, COLLAPSE_CHAR_THRESHOLD)
  const cutIndex = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"))
  return `${candidate.slice(0, cutIndex > 0 ? cutIndex : candidate.length).trimEnd()}…`
}

function looksLikeLogBlob(text: string): boolean {
  const hasErrorWords = /(error|exception|stack|trace|invalid|failed)/i.test(text)
  const hasSignatureNoise = /[{}[\]():;]/.test(text)
  const lines = text.split("\n").length
  return hasErrorWords && hasSignatureNoise && (lines > 8 || text.length > 420)
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

function compactPath(path: string, maxLength = 56): string {
  if (path.length <= maxLength) return path
  const keep = Math.max(10, Math.floor((maxLength - 1) / 2))
  return `${path.slice(0, keep)}…${path.slice(-keep)}`
}

function renderUserContextBlocks(
  parsedObjective: ReturnType<typeof splitUserMessage>["parsedObjective"] | undefined,
  hookContext: ReturnType<typeof splitUserMessage>["hookContext"] | undefined,
  attachedSkills: ReturnType<typeof splitUserMessage>["attachedSkills"] | undefined,
  metadataBlocks: ReturnType<typeof splitUserMessage>["metadataBlocks"] | undefined
): ReactNode {
  const blocks = metadataBlocks ?? []
  const hasContext =
    Boolean(parsedObjective) || Boolean(hookContext) || Boolean(attachedSkills) || blocks.length > 0
  const shouldUnwrapSinglePriorityBlock =
    !parsedObjective &&
    !hookContext &&
    !attachedSkills &&
    blocks.length === 1 &&
    blocks[0]?.kind === "gitAction"
  return (
    <>
      {parsedObjective ? (
        <div className="hook-context-box">
          <p className="hook-context-title">{parsedObjective.title}</p>
          <ul className="hook-context-list">
            {parsedObjective.bullets.map((bullet) => (
              <li key={bullet} className="hook-context-item">
                <span className="hook-context-label">goal</span>
                <span className="hook-context-note">{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hookContext ? (
        <div className="hook-context-box">
          <p className="hook-context-title">
            Hook context{hookContext.source ? ` (${hookContext.source})` : ""}
          </p>
          {hookContext.details.length > 0 ? (
            <ul className="hook-context-list">
              {hookContext.details.map((item) => (
                <li key={`${item.label}:${item.value}`} className="hook-context-item">
                  <span className="hook-context-label">{item.label}</span>
                  <code className="hook-context-value">{item.value}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {hookContext.notes.map((note) => (
            <p key={note} className="hook-context-note">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      {attachedSkills ? (
        <details className="hook-context-box hook-context-collapsible">
          <summary className="hook-context-summary">{attachedSkills.title}</summary>
          {attachedSkills.skills.length > 0 ? (
            <ul className="hook-context-list">
              {attachedSkills.skills.map((skill) => (
                <li key={`${skill.name}:${skill.path ?? ""}`} className="hook-context-item">
                  <span className="hook-context-label">{skill.name}</span>
                  {skill.path ? (
                    <code className="hook-context-value" title={skill.path}>
                      {compactPath(skill.path)}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {attachedSkills.notes.map((note) => (
            <p key={note} className="hook-context-note">
              {note}
            </p>
          ))}
        </details>
      ) : null}
      {blocks.map((block) =>
        shouldUnwrapSinglePriorityBlock ? (
          <div
            key={block.title}
            className={cn(
              "hook-context-box",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null
            )}
          >
            <p className="hook-context-title">{block.title}</p>
            {block.details.length > 0 ? (
              <ul className="hook-context-list">
                {block.details.map((item) => (
                  <li key={`${item.label}:${item.value}`} className="hook-context-item">
                    <span className="hook-context-label">{item.label}</span>
                    <code className="hook-context-value">{item.value}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.notes.map((note) => (
              <p key={note} className="hook-context-note">
                {note}
              </p>
            ))}
          </div>
        ) : (
          <details
            key={block.title}
            className={cn(
              "hook-context-box hook-context-collapsible",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null
            )}
          >
            <summary className="hook-context-summary">{block.title}</summary>
            {block.details.length > 0 ? (
              <ul className="hook-context-list">
                {block.details.map((item) => (
                  <li key={`${item.label}:${item.value}`} className="hook-context-item">
                    <span className="hook-context-label">{item.label}</span>
                    <code className="hook-context-value">{item.value}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.notes.map((note) => (
              <p key={note} className="hook-context-note">
                {note}
              </p>
            ))}
          </details>
        )
      )}
      {hasContext ? <span className="sr-only">Parsed message context available.</span> : null}
    </>
  )
}

function MessageBody({ text, role }: { text: string; role: "user" | "assistant" }) {
  const assistantParts = role === "assistant" ? splitAssistantMessage(text) : null
  const assistantVisible = assistantParts?.visibleText ?? text
  const userParts = role === "user" ? splitUserMessage(text) : null
  const userVisible = userParts?.visibleText ?? text
  const parsedObjective = userParts?.parsedObjective
  const attachedSkills = userParts?.attachedSkills
  const metadataBlocks = userParts?.metadataBlocks ?? []
  const assistantWithJson =
    role === "assistant" ? formatAssistantJsonBlocks(assistantVisible) : text
  const preparedText =
    role === "assistant" ? normalizeAssistantText(assistantWithJson) : userVisible
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
    const hint = buildCollapseHint(preparedText)
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
              <span className="message-expand-hint">{hint}</span>
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
  const hookContext = userParts?.hookContext
  const textForCollapse = userVisible
  const hasOnlyContext = textForCollapse.trim().length === 0
  if (!shouldCollapse) {
    return (
      <>
        {!hasOnlyContext ? <pre className="message-text">{textForCollapse}</pre> : null}
        {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
      </>
    )
  }
  const preview = summarizeText(textForCollapse)
  const hint = buildCollapseHint(textForCollapse)
  return (
    <>
      <details className="message-collapsible">
        <summary>
          <pre className="message-text">{preview}</pre>
          <span className="message-expand-hint">{hint}</span>
        </summary>
        <pre className="message-text">{textForCollapse}</pre>
      </details>
      {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
    </>
  )
}

/* ── Navigation card: projects + sessions list ── */

interface SessionNavProps {
  projects: ProjectSessions[]
  activeAgentPidsByProvider: Record<string, number[]>
  killingPids: Set<number>
  deletingSessionId: string | null
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onSelectProject: (cwd: string) => void
  onSelectSession: (cwd: string, sessionId: string) => void
  onKillAgentPid: (pid: number) => void | Promise<void>
  onDeleteSession: (cwd: string, sessionId: string) => void | Promise<void>
}

export function SessionNav({
  projects,
  activeAgentPidsByProvider,
  killingPids,
  deletingSessionId,
  selectedProjectCwd,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onKillAgentPid,
  onDeleteSession,
}: SessionNavProps) {
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    [projects]
  )
  const selectedProject = useMemo(
    () => sortedProjects.find((p) => p.cwd === selectedProjectCwd) ?? null,
    [sortedProjects, selectedProjectCwd]
  )
  const sortedSessions = useMemo(
    () =>
      selectedProject
        ? dedupeSessionsById(selectedProject.sessions).sort((a, b) => {
            const aDisp = a.dispatches ?? 0
            const bDisp = b.dispatches ?? 0
            if (aDisp > 0 && bDisp === 0) return -1
            if (bDisp > 0 && aDisp === 0) return 1
            return (b.lastMessageAt ?? b.mtime) - (a.lastMessageAt ?? a.mtime)
          })
        : null,
    [selectedProject]
  )
  // Keep "Active now" focused on truly recent activity.
  const activeThresholdMs = 6 * 60 * 1000
  const activeSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) => Date.now() - (session.lastMessageAt ?? session.mtime) <= activeThresholdMs
      ),
    [sortedSessions]
  )
  const recentSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) => Date.now() - (session.lastMessageAt ?? session.mtime) > activeThresholdMs
      ),
    [sortedSessions]
  )
  const selectedProjectCwdSafe = selectedProject?.cwd ?? null

  const renderSessionRow = (session: SessionPreview) => {
    const processPids = providerProcessPids(session.provider, activeAgentPidsByProvider)
    const processLabel = formatProcessPidLabel(processPids)
    const primaryPid = processPids[0]
    const isDeleting = deletingSessionId === session.id
    const isKilling = processPids.some((pid) => killingPids.has(pid))
    const hasLiveProcess = processPids.length > 0 || isKilling
    const actionLabel = hasLiveProcess ? "Kill process" : "Delete session"
    const actionDisabled = hasLiveProcess ? isKilling : isDeleting
    const actionIcon = hasLiveProcess ? (isKilling ? "…" : "✕") : isDeleting ? "…" : "🗑"
    const actionTitle =
      hasLiveProcess && primaryPid
        ? `${actionLabel} ${primaryPid}`
        : hasLiveProcess
          ? actionLabel
          : "Delete session transcript and tasks"

    const activeRuntimeSeconds = session.activeDispatch
      ? Math.max(0, Math.round((Date.now() - session.activeDispatch.startedAt) / 1000))
      : 0

    return (
      <li key={session.id} className="session-row">
        <button
          type="button"
          className={cn("session-btn", session.id === selectedSessionId && "selected")}
          aria-pressed={session.id === selectedSessionId}
          onClick={() => {
            if (!selectedProjectCwdSafe) return
            onSelectSession(selectedProjectCwdSafe, session.id)
          }}
        >
          <span className="session-id" title={session.id}>
            {(session.provider ?? "unknown").toLowerCase()} ·{" "}
            {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
            {processPids.length > 0 ? (
              <span className="agent-process-chip" title={`PIDs: ${processPids.join(", ")}`}>
                <span className="agent-process-dot" aria-hidden="true" />
                {processLabel}
              </span>
            ) : null}
            {session.dispatches ? (
              <span className="session-dispatches">{session.dispatches}</span>
            ) : null}
          </span>
          <span className="session-meta">
            {session.activeDispatch ? (
              <span className="session-active-dispatch" title={session.activeDispatch.requestId}>
                <span className="session-active-pulse" />
                {session.activeDispatch.toolName ? (
                  <>
                    running <strong>{session.activeDispatch.toolName}</strong>
                    {session.activeDispatch.toolInputSummary ? (
                      <span className="session-active-detail">
                        {" "}
                        ({session.activeDispatch.toolInputSummary})
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    running <strong>{session.activeDispatch.canonicalEvent}</strong>
                  </>
                )}
                <span className="session-active-time"> · {activeRuntimeSeconds}s</span>
              </span>
            ) : (
              <>
                {shortSessionId(session.id)} ·{" "}
                {formatCompactTime(session.lastMessageAt ?? session.mtime)}
              </>
            )}
          </span>
        </button>
        <div className="session-actions">
          {confirmingDeleteId === session.id && !hasLiveProcess ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: dismissal via mouse leave
            <div
              className="session-action-confirm"
              onMouseLeave={() => setConfirmingDeleteId(null)}
            >
              <span className="session-action-confirm-text">Delete?</span>
              <button
                type="button"
                className="session-action-btn session-action-delete session-action-delete-confirm"
                onClick={() => {
                  if (!selectedProjectCwdSafe) return
                  setConfirmingDeleteId(null)
                  void onDeleteSession(selectedProjectCwdSafe, session.id)
                }}
                title="Confirm delete"
              >
                Yes
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "session-action-btn",
                hasLiveProcess ? "session-action-kill" : "session-action-delete"
              )}
              onClick={() => {
                if (hasLiveProcess && primaryPid) {
                  void onKillAgentPid(primaryPid)
                  return
                }
                if (!selectedProjectCwdSafe) return
                setConfirmingDeleteId(session.id)
              }}
              disabled={actionDisabled}
              title={actionTitle}
              aria-label={actionTitle}
            >
              <span className="session-action-icon" aria-hidden="true">
                {actionIcon}
              </span>
              <span className="sr-only">{actionLabel}</span>
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
    <nav className="card bento-nav">
      <section className="nav-block">
        <div className="nav-block-header">
          <h2 className="section-title">Projects</h2>
          <span className="nav-count-badge">{sortedProjects.length}</span>
        </div>
        <p className="section-subtitle">Project and session switcher</p>
        <ul className="project-list" aria-label="Active and recent project directories">
          {sortedProjects.map((project) => {
            const projectState = extractProjectState(project.statusLine)
            return (
              <li key={project.cwd}>
                <button
                  type="button"
                  className={cn("project-btn", project.cwd === selectedProjectCwd && "selected")}
                  aria-pressed={project.cwd === selectedProjectCwd}
                  onClick={() => onSelectProject(project.cwd)}
                >
                  <span className="project-name">
                    {project.name}
                    {projectState ? (
                      <span className={cn("project-state-chip", `project-state-${projectState}`)}>
                        {formatProjectStateLabel(projectState)}
                      </span>
                    ) : null}
                  </span>
                  {project.statusLine ? (
                    <span className="project-status-line" title={project.statusLine}>
                      {parseProjectStatusLine(project.statusLine).map((token) => (
                        <span
                          key={`${project.cwd}-${token.label}`}
                          className={cn("project-status-chip", `project-status-${token.tone}`)}
                        >
                          {token.label}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="project-meta">
                    {project.sessionCount} sessions · active{" "}
                    {formatRelativeTime(project.lastSeenAt)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      <section className="nav-block nav-block-sessions">
        <div className="nav-block-header">
          <h2 className="section-title nav-section-title">Sessions</h2>
          <span className="nav-count-badge">{sortedSessions?.length ?? 0}</span>
        </div>
        <ul className="session-list" aria-label="Sessions for selected project">
          {sortedSessions ? (
            <>
              {activeSessions && activeSessions.length > 0 ? (
                <li className="session-group-label">Active now</li>
              ) : null}
              {activeSessions?.map(renderSessionRow)}
              {recentSessions && recentSessions.length > 0 ? (
                <li className="session-group-label">Recent</li>
              ) : null}
              {recentSessions?.map(renderSessionRow)}
            </>
          ) : (
            <li className="empty">Select a project.</li>
          )}
        </ul>
      </section>
    </nav>
  )
}

/* ── Tool stats bar ── */

export interface ToolStat {
  name: string
  count: number
}

function isInternalToolName(name: string): boolean {
  return name.trim().toLowerCase() === "structuredoutput"
}

function ToolStatsBar({ stats }: { stats: ToolStat[] }) {
  const visibleStats = useMemo(
    () => stats.filter((stat) => !isInternalToolName(stat.name)),
    [stats]
  )
  const total = useMemo(() => visibleStats.reduce((sum, s) => sum + s.count, 0), [visibleStats])
  if (visibleStats.length === 0) return null
  return (
    <div className="tool-stats-bar">
      <span className="tool-stats-total">{total} tool calls</span>
      <div className="tool-stats-pills">
        {visibleStats.slice(0, 8).map((s) => (
          <span key={s.name} className="tool-stat-pill">
            <span className="tool-stat-name">{s.name}</span>
            <span className="tool-stat-count">{s.count}</span>
          </span>
        ))}
        {visibleStats.length > 8 && (
          <span className="tool-stat-pill tool-stat-more">+{visibleStats.length - 8} more</span>
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
  projectTasks?: ProjectTask[]
  projectTaskSummary?: SessionTaskSummary | null
  projectTasksLoading?: boolean
}

function TaskStatusBadge({ status }: { status: SessionTask["status"] }) {
  const label = status.replace("_", " ")
  return <span className={cn("task-status", `task-status-${status}`)}>{label}</span>
}

function TaskChecklistMark({ status }: { status: SessionTask["status"] }) {
  const mark =
    status === "completed"
      ? "☑"
      : status === "cancelled"
        ? "☒"
        : status === "in_progress"
          ? "◐"
          : "☐"
  return (
    <span
      className={cn("task-checkmark", `task-checkmark-${status}`)}
      aria-hidden="true"
      title={status.replace("_", " ")}
    >
      {mark}
    </span>
  )
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
                <p className={cn("session-task-subject", `session-task-subject-${task.status}`)}>
                  <TaskChecklistMark status={task.status} />
                  <span>{task.subject}</span>
                </p>
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

function ProjectTasksSection({
  tasks,
  summary,
  loading,
}: {
  tasks: ProjectTask[]
  summary: SessionTaskSummary | null
  loading: boolean
}) {
  const [collapsed, setCollapsed] = useState(true)
  const [visibility, setVisibility] = useState<"open" | "all">("open")
  const [expanded, setExpanded] = useState(false)
  const previewLimit = 16
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const scopedTasks = visibility === "open" ? openTasks : tasks
  const visibleTasks = expanded ? scopedTasks : scopedTasks.slice(0, previewLimit)
  const hiddenCount = Math.max(scopedTasks.length - visibleTasks.length, 0)

  return (
    <section className="session-tasks-section" aria-label="All tasks for selected project">
      <div className="session-tasks-heading">
        <h3 className="session-tasks-title">Project tasks</h3>
        <button
          type="button"
          className="task-collapse-btn"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {summary ? (
        <p className="session-tasks-summary">
          {summary.total} total · {summary.open} open · {summary.completed} completed ·{" "}
          {summary.cancelled} cancelled
        </p>
      ) : null}
      {collapsed ? null : (
        <>
          <div className="session-task-controls">
            <button
              type="button"
              className={cn("task-filter-btn", visibility === "open" && "active")}
              onClick={() => {
                setVisibility("open")
                setExpanded(false)
              }}
              aria-pressed={visibility === "open"}
            >
              Open only ({openTasks.length} shown)
            </button>
            <button
              type="button"
              className={cn("task-filter-btn", visibility === "all" && "active")}
              onClick={() => {
                setVisibility("all")
                setExpanded(false)
              }}
              aria-pressed={visibility === "all"}
            >
              All ({tasks.length} loaded)
            </button>
          </div>
          {summary && tasks.length < summary.total ? (
            <p className="session-tasks-summary">
              Showing latest {tasks.length} of {summary.total} tasks.
            </p>
          ) : null}
          {loading ? (
            <p className="empty">Loading project tasks...</p>
          ) : scopedTasks.length === 0 ? (
            visibility === "open" ? (
              <p className="empty">No open tasks in this project.</p>
            ) : (
              <p className="empty">No tasks recorded for this project.</p>
            )
          ) : (
            <>
              <ul className="session-task-list">
                {visibleTasks.map((task) => {
                  const taskTime = task.statusChangedAt ?? task.completionTimestamp
                  return (
                    <li key={`${task.sessionId}:${task.id}`} className="session-task-row">
                      <div className="session-task-meta">
                        <span className="session-task-id">
                          {task.sessionId.slice(0, 8)}... · #{task.id}
                        </span>
                        <TaskStatusBadge status={task.status} />
                      </div>
                      <p
                        className={cn(
                          "session-task-subject",
                          `session-task-subject-${task.status}`
                        )}
                      >
                        <TaskChecklistMark status={task.status} />
                        <span>{task.subject}</span>
                      </p>
                      {taskTime ? (
                        <p className="session-task-time">
                          {formatTime(new Date(taskTime).getTime())}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="task-show-more-btn"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "Show fewer tasks" : `Show ${hiddenCount} more tasks`}
                </button>
              ) : null}
            </>
          )}
        </>
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
  projectTasks = [],
  projectTaskSummary = null,
  projectTasksLoading = false,
}: MessagesProps) {
  const sorted = useMemo(
    () =>
      [...messages].sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      }),
    [messages]
  )
  const grouped = useMemo(() => groupMessages(sorted), [sorted])

  return (
    <section className="card bento-messages">
      <h2 className="section-title">Transcript</h2>
      <p className="section-subtitle">Conversation history for selected session</p>
      <ProjectTasksSection
        tasks={projectTasks}
        summary={projectTaskSummary}
        loading={projectTasksLoading}
      />
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
              <li key={key} className={cn("message-row", message.role, isNew && "message-new")}>
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
                        {tc.detail && (
                          <span
                            className="tool-detail"
                            // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped via renderInline
                            dangerouslySetInnerHTML={{ __html: renderInline(tc.detail) }}
                          />
                        )}
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
