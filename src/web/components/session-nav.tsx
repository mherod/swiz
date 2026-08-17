import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
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

type KillConfirmation = { sessionId: string; pid: number } | null

interface SessionRowProps {
  session: SessionPreview
  selectedSessionId: string | null
  selectedProjectCwd: string | null
  activeAgentPidsByProvider: Record<string, number[]>
  killingPids: Set<number>
  deletingSessionId: string | null
  confirmingDeleteId: string | null
  setConfirmingDeleteId: (id: string | null) => void
  confirmingKill: KillConfirmation
  setConfirmingKill: (confirmation: KillConfirmation) => void
  groupKind: "active" | "recent"
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
  const actionIcon = hasLiveProcess ? (isKilling ? "…" : "Kill") : isDeleting ? "…" : "Del"
  const actionTitle =
    hasLiveProcess && primaryPid
      ? `${actionLabel} ${primaryPid}`
      : hasLiveProcess
        ? actionLabel
        : "Delete session transcript and tasks"
  return { actionLabel, actionDisabled, actionIcon, actionTitle }
}

function SessionRowHeader({
  session,
  provider,
  relativeTime,
  sessionTime,
}: {
  session: SessionPreview
  provider: string
  relativeTime: string
  sessionTime: number
}) {
  return (
    <div className="session-header">
      <span className="session-provider">{provider}</span>
      <time
        className="session-time"
        dateTime={new Date(sessionTime).toISOString()}
        title={new Date(sessionTime).toLocaleString()}
      >
        {relativeTime}
      </time>
      {session.dispatches ? (
        <span className="session-dispatches" title={`${session.dispatches} dispatches`}>
          {session.dispatches}
        </span>
      ) : null}
    </div>
  )
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
  const relativeTime = formatRelativeTime(session.lastMessageAt ?? session.mtime)
  const provider = (session.provider ?? "unknown").toLowerCase()
  const stateSummary = session.processAlive ? "active" : "recent"
  const sessionTime = session.lastMessageAt ?? session.mtime
  const processSummary = processPids.length > 0 ? `, process IDs ${processPids.join(", ")}` : ""
  const dispatchSummary = session.dispatches ? `, ${session.dispatches} dispatches` : ""

  return (
    <button
      type="button"
      data-session-select={session.id}
      className={cn(
        "session-btn session-btn-content",
        session.id === selectedSessionId && "selected"
      )}
      aria-pressed={session.id === selectedSessionId}
      aria-label={`Open ${provider} session ${session.id}, ${stateSummary}, updated ${relativeTime}${dispatchSummary}${processSummary}`}
      onClick={() => {
        if (!selectedProjectCwd) return
        onSelectSession(selectedProjectCwd, session.id)
      }}
    >
      <SessionRowHeader
        session={session}
        provider={provider}
        relativeTime={relativeTime}
        sessionTime={sessionTime}
      />
      <SessionDetailsRow
        session={session}
        activeRuntimeSeconds={activeRuntimeSeconds}
        processPids={processPids}
        processLabel={processLabel}
      />
    </button>
  )
}

function compactSessionId(sessionId: string): string {
  if (sessionId.length <= 20) return sessionId
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-7)}`
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
          <span className="sr-only">Process IDs </span>
          {processLabel}
        </span>
      ) : null}
      {session.activeDispatch ? (
        <ActiveDispatchLabel
          dispatch={session.activeDispatch}
          activeRuntimeSeconds={activeRuntimeSeconds}
        />
      ) : (
        <span className="session-id-text" title={session.id}>
          {compactSessionId(session.id)}
        </span>
      )}
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

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable")
  await navigator.clipboard.writeText(value)
}

type CopyResult = "copied" | "failed" | null

function copyPresentation(result: CopyResult, label: string, defaultTitle: string) {
  if (result === "copied") return { glyph: "✓", message: `${label} copied.`, title: "Copied" }
  if (result === "failed") return { glyph: "!", message: `${label} failed.`, title: "Copy failed" }
  return { glyph: "⧉", message: "", title: defaultTitle }
}

function SessionCopyButton({
  value,
  label,
  title,
}: {
  value: string
  label: string
  title: string
}) {
  const copyAttempt = useRef(0)
  const [status, setStatus] = useState<{
    attempt: number
    result: Exclude<CopyResult, null>
    value: string
  } | null>(null)
  const currentStatus = status?.value === value ? status : null
  const presentation = copyPresentation(currentStatus?.result ?? null, label, title)

  const handleCopy = useCallback(async () => {
    const attempt = copyAttempt.current + 1
    copyAttempt.current = attempt
    setStatus(null)
    try {
      await copyText(value)
      if (copyAttempt.current === attempt) setStatus({ attempt, result: "copied", value })
    } catch {
      if (copyAttempt.current === attempt) setStatus({ attempt, result: "failed", value })
    }
  }, [value])

  return (
    <>
      <button
        type="button"
        className="session-action-btn session-action-copy"
        onClick={() => void handleCopy()}
        title={presentation.title}
        aria-label={label}
      >
        <span aria-hidden="true">{presentation.glyph}</span>
      </button>
      <output
        key={currentStatus?.attempt ?? 0}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {presentation.message}
      </output>
    </>
  )
}

function KillConfirmationButton({
  pid,
  onKill,
  onDismiss,
}: {
  pid: number
  onKill: (pid: number) => void | Promise<void>
  onDismiss: (restoreFocus?: boolean) => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onDismiss])

  return (
    <fieldset
      className="session-action-confirm session-action-confirm-kill"
      aria-label={`Confirm killing process ${pid}`}
    >
      <legend className="session-action-confirm-text">Kill {pid}?</legend>
      <button
        ref={confirmRef}
        type="button"
        className="session-action-btn session-action-kill session-action-delete-confirm"
        onClick={() => {
          const sessionButton =
            confirmRef.current
              ?.closest(".session-row")
              ?.querySelector<HTMLButtonElement>(".session-btn") ?? null
          onDismiss(false)
          void onKill(pid)
          requestAnimationFrame(() => sessionButton?.focus())
        }}
        title={`Confirm kill process ${pid}`}
      >
        Yes
      </button>
      <button
        type="button"
        className="session-action-btn session-action-cancel session-action-delete-confirm"
        onClick={() => onDismiss()}
      >
        Cancel
      </button>
    </fieldset>
  )
}

function findSessionRemovalFocusTarget(
  confirmButton: HTMLButtonElement | null
): HTMLElement | null {
  const row = confirmButton?.closest<HTMLElement>(".session-row")
  const list = row?.parentElement
  if (!row || !list) return document.getElementById("sessions-heading")
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".session-row"))
  const index = rows.indexOf(row)
  const targetRow = rows[index + 1] ?? rows[index - 1]
  return (
    targetRow?.querySelector<HTMLElement>(".session-btn") ??
    document.getElementById("sessions-heading")
  )
}

function DeleteConfirmationButton({
  sessionId,
  selectedProjectCwd,
  onDelete,
  onDismiss,
}: {
  sessionId: string
  selectedProjectCwd: string | null
  onDelete: (cwd: string, sessionId: string) => void | Promise<void>
  onDismiss: (restoreFocus?: boolean) => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onDismiss])

  return (
    <fieldset className="session-action-confirm" aria-label="Confirm deleting session">
      <legend className="session-action-confirm-text">Delete?</legend>
      <button
        ref={confirmRef}
        type="button"
        className="session-action-btn session-action-delete session-action-delete-confirm"
        onClick={() => {
          if (!selectedProjectCwd) return
          const focusTarget = findSessionRemovalFocusTarget(confirmRef.current)
          onDismiss(false)
          void onDelete(selectedProjectCwd, sessionId)
          requestAnimationFrame(() => focusTarget?.focus())
        }}
        title="Confirm delete"
      >
        Yes
      </button>
      <button
        type="button"
        className="session-action-btn session-action-cancel session-action-delete-confirm"
        onClick={() => onDismiss()}
      >
        Cancel
      </button>
    </fieldset>
  )
}

function SessionActionButton({
  actionLabel,
  actionDisabled,
  actionIcon,
  actionTitle,
  hasLiveProcess,
  buttonRef,
  onClick,
}: {
  actionLabel: string
  actionDisabled: boolean
  actionIcon: React.ReactNode
  actionTitle: string
  hasLiveProcess: boolean
  buttonRef: React.RefObject<HTMLButtonElement | null>
  onClick: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        "session-action-btn",
        hasLiveProcess ? "session-action-kill" : "session-action-delete"
      )}
      onClick={onClick}
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

type SessionRowActionsProps = {
  session: SessionPreview
  hasLiveProcess: boolean
  primaryPid: number | undefined
  isKilling: boolean
  isDeleting: boolean
  confirmingDeleteId: string | null
  confirmingKill: KillConfirmation
  selectedProjectCwd: string | null
  setConfirmingDeleteId: (id: string | null) => void
  setConfirmingKill: (confirmation: KillConfirmation) => void
  onKillAgentPid: (pid: number) => void | Promise<void>
  onDeleteSession: (cwd: string, sessionId: string) => void | Promise<void>
}

function useSessionActionClick({
  session,
  hasLiveProcess,
  primaryPid,
  selectedProjectCwd,
  setConfirmingDeleteId,
  setConfirmingKill,
}: Pick<
  SessionRowActionsProps,
  | "session"
  | "hasLiveProcess"
  | "primaryPid"
  | "selectedProjectCwd"
  | "setConfirmingDeleteId"
  | "setConfirmingKill"
>) {
  return useCallback(() => {
    if (hasLiveProcess && primaryPid) {
      setConfirmingKill({ sessionId: session.id, pid: primaryPid })
      return
    }
    if (!selectedProjectCwd) return
    setConfirmingKill(null)
    setConfirmingDeleteId(session.id)
  }, [
    hasLiveProcess,
    primaryPid,
    selectedProjectCwd,
    session.id,
    setConfirmingDeleteId,
    setConfirmingKill,
  ])
}

function renderSessionRowActionConfirmation(
  props: Omit<SessionRowActionsProps, "isKilling" | "isDeleting">,
  onDismiss: (restoreFocus?: boolean) => void
): ReactElement | null {
  if (
    props.hasLiveProcess &&
    props.primaryPid &&
    props.confirmingKill?.sessionId === props.session.id &&
    props.confirmingKill.pid === props.primaryPid
  ) {
    return (
      <KillConfirmationButton
        pid={props.primaryPid}
        onKill={props.onKillAgentPid}
        onDismiss={onDismiss}
      />
    )
  }

  if (props.confirmingDeleteId !== props.session.id || props.hasLiveProcess) return null
  return (
    <DeleteConfirmationButton
      sessionId={props.session.id}
      selectedProjectCwd={props.selectedProjectCwd}
      onDelete={props.onDeleteSession}
      onDismiss={onDismiss}
    />
  )
}

function SessionRowActions(props: SessionRowActionsProps) {
  const actionTriggerRef = useRef<HTMLButtonElement>(null)
  const { actionLabel, actionDisabled, actionIcon, actionTitle } = resolveSessionAction(
    props.hasLiveProcess,
    props.isKilling,
    props.isDeleting,
    props.primaryPid
  )
  const handleClick = useSessionActionClick(props)
  const dismissConfirmation = useCallback(
    (restoreFocus = true) => {
      props.setConfirmingDeleteId(null)
      props.setConfirmingKill(null)
      if (restoreFocus) requestAnimationFrame(() => actionTriggerRef.current?.focus())
    },
    [props.setConfirmingDeleteId, props.setConfirmingKill]
  )
  const confirmation = renderSessionRowActionConfirmation(props, dismissConfirmation)

  if (confirmation) return confirmation
  return (
    <SessionActionButton
      actionLabel={actionLabel}
      actionDisabled={actionDisabled}
      actionIcon={actionIcon}
      actionTitle={actionTitle}
      hasLiveProcess={props.hasLiveProcess}
      buttonRef={actionTriggerRef}
      onClick={handleClick}
    />
  )
}

function SessionRow(props: SessionRowProps) {
  const { session, activeAgentPidsByProvider, killingPids, deletingSessionId } = props
  const processPids = session.processAlive
    ? providerProcessPids(session.provider, activeAgentPidsByProvider)
    : []
  const processLabel = formatProcessPidLabel(processPids)
  const primaryPid = processPids[0]
  const isDeleting = deletingSessionId === session.id
  const isKilling = processPids.some((pid) => killingPids.has(pid))
  const hasLiveProcess = session.processAlive || processPids.length > 0 || isKilling

  return (
    <li
      className={cn(
        "session-row",
        hasLiveProcess && "session-row-live",
        props.groupKind === "recent" && "session-row-recent"
      )}
    >
      <SessionRowButton
        session={session}
        selectedSessionId={props.selectedSessionId}
        selectedProjectCwd={props.selectedProjectCwd}
        onSelectSession={props.onSelectSession}
        processPids={processPids}
        processLabel={processLabel}
      />
      <div className="session-actions">
        <SessionCopyButton
          value={session.id}
          label={`Copy session ID ${session.id}`}
          title="Copy full session ID"
        />
        {processPids.length > 0 ? (
          <SessionCopyButton
            value={processPids.join(",")}
            label={`Copy process IDs ${processPids.join(", ")}`}
            title="Copy process IDs"
          />
        ) : null}
        <SessionRowActions
          session={session}
          hasLiveProcess={hasLiveProcess}
          primaryPid={primaryPid}
          isKilling={isKilling}
          isDeleting={isDeleting}
          confirmingDeleteId={props.confirmingDeleteId}
          confirmingKill={props.confirmingKill}
          selectedProjectCwd={props.selectedProjectCwd}
          setConfirmingDeleteId={props.setConfirmingDeleteId}
          setConfirmingKill={props.setConfirmingKill}
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
  const lastSeenLabel = formatRelativeTime(project.lastSeenAt)
  const lastSeenIso = new Date(project.lastSeenAt).toISOString()
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
          <span>
            {project.sessionCount} session{project.sessionCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true"> · </span>
          <span>
            Active{" "}
            <time dateTime={lastSeenIso} title={new Date(project.lastSeenAt).toLocaleString()}>
              {lastSeenLabel}
            </time>
          </span>
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
  sessionRowProps: Omit<SessionRowProps, "session" | "groupKind">
}) {
  if (!sessions || sessions.length === 0) return null
  return (
    <>
      <li className="session-group-label">
        {label} <span className="session-group-count">{sessions.length}</span>
      </li>
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          groupKind={label === "Active" ? "active" : "recent"}
          {...sessionRowProps}
        />
      ))}
    </>
  )
}

function computeFilteredSessions(
  sessions: SessionPreview[] | undefined,
  filterQuery: string
): SessionPreview[] | undefined {
  return filterQuery ? sessions?.filter((s) => matchesFilter(s, filterQuery)) : sessions
}

function computeSessionsCounts(
  filteredActive: SessionPreview[] | undefined,
  filteredRecent: SessionPreview[] | undefined,
  filterQuery: string,
  totalSessions: number
): { total: number; active: number; recent: number } {
  const filteredSum = (filteredActive?.length ?? 0) + (filteredRecent?.length ?? 0)
  return {
    total: filterQuery ? filteredSum : totalSessions,
    active: filteredActive?.length ?? 0,
    recent: filteredRecent?.length ?? 0,
  }
}

function projectNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "")
  return normalized.split("/").pop() || cwd
}

function ProjectSessionsHeader({
  project,
  counts,
}: {
  project: ProjectSessions
  counts: { total: number; active: number; recent: number }
}) {
  const statusTokens = parseProjectStatusLine(project.statusLine).slice(0, 2)
  return (
    <>
      <div className="nav-inline-header nav-inline-header-sessions">
        <h2 id="sessions-heading" className="section-title nav-section-title" tabIndex={-1}>
          Sessions
        </h2>
        <span className="nav-count-badge">{counts.total}</span>
      </div>
      <p className="nav-inline-project">
        {project.name} · {counts.active} active · {counts.recent} recent
      </p>
      <StatusChips
        tokens={statusTokens}
        keyPrefix={`${project.cwd}-selected`}
        statusLine={project.statusLine}
      />
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
  sessionRowProps: Omit<SessionRowProps, "session" | "groupKind">
}) {
  const filteredActive = useMemo(
    () => computeFilteredSessions(activeSessions, filterQuery),
    [activeSessions, filterQuery]
  )
  const filteredRecent = useMemo(
    () => computeFilteredSessions(recentSessions, filterQuery),
    [recentSessions, filterQuery]
  )
  const counts = computeSessionsCounts(
    filteredActive,
    filteredRecent,
    filterQuery,
    sortedSessions?.length ?? 0
  )

  return (
    <>
      <ProjectSessionsHeader project={selectedProject} counts={counts} />
      <label className="session-filter-label" htmlFor="session-filter">
        Find a session
      </label>
      <input
        id="session-filter"
        type="search"
        className="session-filter-input"
        placeholder="ID, provider, or tool"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
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

function useSelectedSessionScroll(
  navRef: React.RefObject<HTMLElement | null>,
  selectedSessionId: string | null,
  selectedSessionVisible: boolean
): void {
  useEffect(() => {
    if (
      !selectedSessionId ||
      !selectedSessionVisible ||
      !window.matchMedia("(min-width: 900px)").matches
    )
      return
    const selectedButton = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-select]") ?? []
    ).find((button) => button.dataset.sessionSelect === selectedSessionId)
    selectedButton?.scrollIntoView({ block: "nearest" })
  }, [navRef, selectedSessionId, selectedSessionVisible])
}

function sessionMatches(
  sessions: SessionPreview[] | null,
  selectedSessionId: string | null,
  filterQuery: string
): boolean {
  return Boolean(
    sessions?.some(
      (session) =>
        session.id === selectedSessionId && (!filterQuery || matchesFilter(session, filterQuery))
    )
  )
}

export function SessionNav(props: SessionNavProps): ReactElement {
  const { selectedProjectCwd, selectedSessionId, onSelectProject } = props
  const navRef = useRef<HTMLElement>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [confirmingKill, setConfirmingKill] = useState<KillConfirmation>(null)
  const [filterQuery, setFilterQuery] = useState("")
  const navState = useSessionNavState(props.projects, selectedProjectCwd)
  const isSelectedVisible = sessionMatches(navState.sortedSessions, selectedSessionId, filterQuery)
  useSelectedSessionScroll(navRef, selectedSessionId, isSelectedVisible)

  const sessionRowProps = {
    selectedSessionId,
    selectedProjectCwd: navState.selectedProject?.cwd ?? null,
    activeAgentPidsByProvider: props.activeAgentPidsByProvider,
    killingPids: props.killingPids,
    deletingSessionId: props.deletingSessionId,
    confirmingDeleteId,
    setConfirmingDeleteId,
    confirmingKill,
    setConfirmingKill,
    onSelectSession: props.onSelectSession,
    onKillAgentPid: props.onKillAgentPid,
    onDeleteSession: props.onDeleteSession,
  }

  return (
    <nav ref={navRef} className="card bento-nav" aria-label="Projects and sessions">
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
      ) : selectedProjectCwd ? (
        <p className="empty nav-empty-inline">
          Loading sessions for {projectNameFromCwd(selectedProjectCwd)}.
        </p>
      ) : (
        <p className="empty nav-empty-inline">Select a project to view sessions.</p>
      )}
    </nav>
  )
}
