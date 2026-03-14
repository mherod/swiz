import { useMemo, useState } from "react"
import { cn } from "../lib/cn.ts"
import type { ProjectSessions, SessionPreview } from "./session-browser-types.ts"
import {
  dedupeSessionsById,
  extractProjectState,
  formatProcessPidLabel,
  formatProjectStateLabel,
  formatRelativeTime,
  parseProjectStatusLine,
  providerProcessPids,
  shortSessionId,
} from "./session-browser-utils.ts"

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

interface SessionRowProps {
  session: SessionPreview
  selectedSessionId: string | null
  selectedProjectCwd: string | null
  activeAgentPidsByProvider: Record<string, number[]>
  killingPids: Set<number>
  deletingSessionId: string | null
  confirmingDeleteId: string | null
  setConfirmingDeleteId: (id: string | null) => void
  onSelectSession: (cwd: string, sessionId: string) => void
  onKillAgentPid: (pid: number) => void | Promise<void>
  onDeleteSession: (cwd: string, sessionId: string) => void | Promise<void>
}

function resolveSessionAction(
  hasLiveProcess: boolean,
  isKilling: boolean,
  isDeleting: boolean,
  primaryPid: number | undefined
) {
  const actionLabel = hasLiveProcess ? "Kill process" : "Delete session"
  const actionDisabled = hasLiveProcess ? isKilling : isDeleting
  const actionIcon = hasLiveProcess ? (isKilling ? "…" : "✕") : isDeleting ? "…" : "🗑"
  const actionTitle =
    hasLiveProcess && primaryPid
      ? `${actionLabel} ${primaryPid}`
      : hasLiveProcess
        ? actionLabel
        : "Delete session transcript and tasks"
  return { actionLabel, actionDisabled, actionIcon, actionTitle }
}

function SessionRowButton({
  session,
  selectedSessionId,
  selectedProjectCwd,
  onSelectSession,
  processPids,
  processLabel,
}: Pick<
  SessionRowProps,
  "session" | "selectedSessionId" | "selectedProjectCwd" | "onSelectSession"
> & {
  processPids: number[]
  processLabel: string
}) {
  const activeRuntimeSeconds = session.activeDispatch
    ? Math.max(0, Math.round((Date.now() - session.activeDispatch.startedAt) / 1000))
    : 0

  return (
    <button
      type="button"
      className={cn("session-btn", session.id === selectedSessionId && "selected")}
      aria-pressed={session.id === selectedSessionId}
      onClick={() => {
        if (!selectedProjectCwd) return
        onSelectSession(selectedProjectCwd, session.id)
      }}
    >
      <div className="session-btn-content">
        <div className="session-header">
          <span className="session-provider">{(session.provider ?? "unknown").toLowerCase()}</span>
          <span className="session-time">
            {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
          </span>
          {session.dispatches ? (
            <span className="session-dispatches" title={`${session.dispatches} dispatches`}>
              {session.dispatches}
            </span>
          ) : null}
        </div>
        <SessionDetailsRow
          session={session}
          activeRuntimeSeconds={activeRuntimeSeconds}
          processPids={processPids}
          processLabel={processLabel}
        />
      </div>
    </button>
  )
}

function SessionDetailsRow({
  session,
  activeRuntimeSeconds,
  processPids,
  processLabel,
}: {
  session: SessionPreview
  activeRuntimeSeconds: number
  processPids: number[]
  processLabel: string
}) {
  return (
    <div className="session-details">
      {processPids.length > 0 ? (
        <span className="agent-process-chip" title={`PIDs: ${processPids.join(", ")}`}>
          <span className="agent-process-dot" aria-hidden="true" />
          {processLabel}
        </span>
      ) : null}
      <span className="session-meta">
        {session.activeDispatch ? (
          <ActiveDispatchLabel
            dispatch={session.activeDispatch}
            activeRuntimeSeconds={activeRuntimeSeconds}
          />
        ) : (
          <span className="session-id-text" title={session.id}>
            {shortSessionId(session.id)}
          </span>
        )}
      </span>
    </div>
  )
}

function ActiveDispatchLabel({
  dispatch,
  activeRuntimeSeconds,
}: {
  dispatch: NonNullable<SessionPreview["activeDispatch"]>
  activeRuntimeSeconds: number
}) {
  return (
    <span className="session-active-dispatch" title={dispatch.requestId}>
      <span className="session-active-pulse" />
      {dispatch.toolName ? (
        <>
          <span>{dispatch.toolName}</span>
          {dispatch.toolInputSummary ? (
            <span className="session-active-detail"> ({dispatch.toolInputSummary})</span>
          ) : null}
        </>
      ) : (
        <span>{dispatch.canonicalEvent}</span>
      )}
      <span className="session-active-time"> · {activeRuntimeSeconds}s</span>
    </span>
  )
}

function SessionRowActions({
  session,
  hasLiveProcess,
  primaryPid,
  isKilling,
  isDeleting,
  confirmingDeleteId,
  selectedProjectCwd,
  setConfirmingDeleteId,
  onKillAgentPid,
  onDeleteSession,
}: {
  session: SessionPreview
  hasLiveProcess: boolean
  primaryPid: number | undefined
  isKilling: boolean
  isDeleting: boolean
  confirmingDeleteId: string | null
  selectedProjectCwd: string | null
  setConfirmingDeleteId: (id: string | null) => void
  onKillAgentPid: (pid: number) => void | Promise<void>
  onDeleteSession: (cwd: string, sessionId: string) => void | Promise<void>
}) {
  const { actionLabel, actionDisabled, actionIcon, actionTitle } = resolveSessionAction(
    hasLiveProcess,
    isKilling,
    isDeleting,
    primaryPid
  )

  if (confirmingDeleteId === session.id && !hasLiveProcess) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: dismissal via mouse leave
      <div className="session-action-confirm" onMouseLeave={() => setConfirmingDeleteId(null)}>
        <span className="session-action-confirm-text">Delete?</span>
        <button
          type="button"
          className="session-action-btn session-action-delete session-action-delete-confirm"
          onClick={() => {
            if (!selectedProjectCwd) return
            setConfirmingDeleteId(null)
            void onDeleteSession(selectedProjectCwd, session.id)
          }}
          title="Confirm delete"
        >
          Yes
        </button>
      </div>
    )
  }

  return (
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
        if (!selectedProjectCwd) return
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
  )
}

function SessionRow(props: SessionRowProps) {
  const { session, activeAgentPidsByProvider, killingPids, deletingSessionId } = props
  const processPids = providerProcessPids(session.provider, activeAgentPidsByProvider)
  const processLabel = formatProcessPidLabel(processPids)
  const primaryPid = processPids[0]
  const isDeleting = deletingSessionId === session.id
  const isKilling = processPids.some((pid) => killingPids.has(pid))
  const hasLiveProcess = session.processAlive || processPids.length > 0 || isKilling

  return (
    <li className="session-row">
      <SessionRowButton
        session={session}
        selectedSessionId={props.selectedSessionId}
        selectedProjectCwd={props.selectedProjectCwd}
        onSelectSession={props.onSelectSession}
        processPids={processPids}
        processLabel={processLabel}
      />
      <div className="session-actions">
        <SessionRowActions
          session={session}
          hasLiveProcess={hasLiveProcess}
          primaryPid={primaryPid}
          isKilling={isKilling}
          isDeleting={isDeleting}
          confirmingDeleteId={props.confirmingDeleteId}
          selectedProjectCwd={props.selectedProjectCwd}
          setConfirmingDeleteId={props.setConfirmingDeleteId}
          onKillAgentPid={props.onKillAgentPid}
          onDeleteSession={props.onDeleteSession}
        />
      </div>
    </li>
  )
}

function ProjectListItem({
  project,
  selectedProjectCwd,
  onSelectProject,
}: {
  project: ProjectSessions
  selectedProjectCwd: string | null
  onSelectProject: (cwd: string) => void
}) {
  const projectState = extractProjectState(project.statusLine)
  const projectStatus = parseProjectStatusLine(project.statusLine).slice(0, 1)
  return (
    <li>
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
        <span className="project-meta">
          {project.sessionCount} sessions · {formatRelativeTime(project.lastSeenAt)}
        </span>
        {projectStatus.length > 0 ? (
          <span className="project-status-line" title={project.statusLine}>
            {projectStatus.map((token) => (
              <span
                key={`${project.cwd}-${token.label}`}
                className={cn("project-status-chip", `project-status-${token.tone}`)}
              >
                {token.label}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  )
}

function StatusChips({
  tokens,
  keyPrefix,
  statusLine,
}: {
  tokens: Array<{ label: string; tone: string }>
  keyPrefix: string
  statusLine?: string
}) {
  if (tokens.length === 0) return null
  return (
    <div className="project-status-line nav-inline-status" title={statusLine}>
      {tokens.map((token) => (
        <span
          key={`${keyPrefix}-${token.label}`}
          className={cn("project-status-chip", `project-status-${token.tone}`)}
        >
          {token.label}
        </span>
      ))}
    </div>
  )
}

function matchesFilter(session: SessionPreview, query: string): boolean {
  const q = query.toLowerCase()
  const fields = [
    session.id,
    session.provider,
    session.activeDispatch?.toolName,
    session.activeDispatch?.canonicalEvent,
    session.activeDispatch?.toolInputSummary,
  ]
  return fields.some((f) => f?.toLowerCase().includes(q))
}

function useSessionNavState(projects: ProjectSessions[], selectedProjectCwd: string | null) {
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
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
  const activeThresholdMs = 6 * 60 * 1000
  const activeSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) =>
          session.processAlive ||
          Date.now() - (session.lastMessageAt ?? session.mtime) <= activeThresholdMs
      ),
    [sortedSessions]
  )
  const recentSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) =>
          !session.processAlive &&
          Date.now() - (session.lastMessageAt ?? session.mtime) > activeThresholdMs
      ),
    [sortedSessions]
  )
  return { sortedProjects, selectedProject, sortedSessions, activeSessions, recentSessions }
}

function SessionGroupList({
  label,
  sessions,
  sessionRowProps,
}: {
  label: string
  sessions: SessionPreview[] | null | undefined
  sessionRowProps: Omit<SessionRowProps, "session">
}) {
  if (!sessions || sessions.length === 0) return null
  return (
    <>
      <li className="session-group-label">
        {label} <span className="session-group-count">{sessions.length}</span>
      </li>
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} {...sessionRowProps} />
      ))}
    </>
  )
}

function SelectedProjectPanel({
  selectedProject,
  sortedSessions,
  activeSessions,
  recentSessions,
  filterQuery,
  onFilterChange,
  sessionRowProps,
}: {
  selectedProject: ProjectSessions
  sortedSessions: SessionPreview[] | null
  activeSessions: SessionPreview[] | undefined
  recentSessions: SessionPreview[] | undefined
  filterQuery: string
  onFilterChange: (query: string) => void
  sessionRowProps: Omit<SessionRowProps, "session">
}) {
  const statusTokens = parseProjectStatusLine(selectedProject.statusLine).slice(0, 2)

  const filteredActive = useMemo(
    () =>
      filterQuery ? activeSessions?.filter((s) => matchesFilter(s, filterQuery)) : activeSessions,
    [activeSessions, filterQuery]
  )
  const filteredRecent = useMemo(
    () =>
      filterQuery ? recentSessions?.filter((s) => matchesFilter(s, filterQuery)) : recentSessions,
    [recentSessions, filterQuery]
  )
  const filteredTotal = (filteredActive?.length ?? 0) + (filteredRecent?.length ?? 0)

  return (
    <>
      <div className="nav-inline-header nav-inline-header-sessions">
        <h2 className="section-title nav-section-title">Sessions</h2>
        <span className="nav-count-badge">
          {filterQuery ? filteredTotal : (sortedSessions?.length ?? 0)}
        </span>
      </div>
      <p className="nav-inline-project">
        {selectedProject.name} · {filteredActive?.length ?? 0} active ·{" "}
        {filteredRecent?.length ?? 0} recent
      </p>
      <StatusChips
        tokens={statusTokens}
        keyPrefix={`${selectedProject.cwd}-selected`}
        statusLine={selectedProject.statusLine}
      />
      <input
        type="search"
        className="session-filter-input"
        placeholder="Filter sessions…"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
        aria-label="Filter sessions by keyword"
      />
      <ul className="session-list" aria-label="Sessions for selected project">
        <SessionGroupList
          label="Active"
          sessions={filteredActive}
          sessionRowProps={sessionRowProps}
        />
        <SessionGroupList
          label="Recent"
          sessions={filteredRecent}
          sessionRowProps={sessionRowProps}
        />
      </ul>
    </>
  )
}

export function SessionNav(props: SessionNavProps) {
  const { selectedProjectCwd, selectedSessionId, onSelectProject } = props
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState("")
  const navState = useSessionNavState(props.projects, selectedProjectCwd)

  const sessionRowProps = {
    selectedSessionId,
    selectedProjectCwd: navState.selectedProject?.cwd ?? null,
    activeAgentPidsByProvider: props.activeAgentPidsByProvider,
    killingPids: props.killingPids,
    deletingSessionId: props.deletingSessionId,
    confirmingDeleteId,
    setConfirmingDeleteId,
    onSelectSession: props.onSelectSession,
    onKillAgentPid: props.onKillAgentPid,
    onDeleteSession: props.onDeleteSession,
  }

  return (
    <nav className="card bento-nav">
      <div className="nav-inline-header">
        <h2 className="section-title">Projects</h2>
        <span className="nav-count-badge">{navState.sortedProjects.length}</span>
      </div>
      <ul className="project-list" aria-label="Active and recent project directories">
        {navState.sortedProjects.map((project) => (
          <ProjectListItem
            key={project.cwd}
            project={project}
            selectedProjectCwd={selectedProjectCwd}
            onSelectProject={onSelectProject}
          />
        ))}
      </ul>
      {navState.selectedProject ? (
        <SelectedProjectPanel
          selectedProject={navState.selectedProject}
          sortedSessions={navState.sortedSessions}
          activeSessions={navState.activeSessions}
          recentSessions={navState.recentSessions}
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
          sessionRowProps={sessionRowProps}
        />
      ) : (
        <p className="empty nav-empty-inline">Select a project to view sessions.</p>
      )}
    </nav>
  )
}
