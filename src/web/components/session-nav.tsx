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
  // "Active now" uses verified process liveness first, with recency as fallback.
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
  const selectedProjectCwdSafe = selectedProject?.cwd ?? null
  const selectedProjectStatus = selectedProject
    ? parseProjectStatusLine(selectedProject.statusLine).slice(0, 2)
    : []

  const renderSessionRow = (session: SessionPreview) => {
    const processPids = providerProcessPids(session.provider, activeAgentPidsByProvider)
    const processLabel = formatProcessPidLabel(processPids)
    const primaryPid = processPids[0]
    const isDeleting = deletingSessionId === session.id
    const isKilling = processPids.some((pid) => killingPids.has(pid))
    const hasLiveProcess = session.processAlive || processPids.length > 0 || isKilling
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
          <div className="session-btn-content">
            <div className="session-header">
              <span className="session-provider">
                {(session.provider ?? "unknown").toLowerCase()}
              </span>
              <span className="session-time">
                {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
              </span>
              {session.dispatches ? (
                <span className="session-dispatches" title={`${session.dispatches} dispatches`}>
                  {session.dispatches}
                </span>
              ) : null}
            </div>

            <div className="session-details">
              {processPids.length > 0 ? (
                <span className="agent-process-chip" title={`PIDs: ${processPids.join(", ")}`}>
                  <span className="agent-process-dot" aria-hidden="true" />
                  {processLabel}
                </span>
              ) : null}

              <span className="session-meta">
                {session.activeDispatch ? (
                  <span
                    className="session-active-dispatch"
                    title={session.activeDispatch.requestId}
                  >
                    <span className="session-active-pulse" />
                    {session.activeDispatch.toolName ? (
                      <>
                        <span>{session.activeDispatch.toolName}</span>
                        {session.activeDispatch.toolInputSummary ? (
                          <span className="session-active-detail">
                            {" "}
                            ({session.activeDispatch.toolInputSummary})
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span>{session.activeDispatch.canonicalEvent}</span>
                    )}
                    <span className="session-active-time"> · {activeRuntimeSeconds}s</span>
                  </span>
                ) : (
                  <span className="session-id-text" title={session.id}>
                    {shortSessionId(session.id)}
                  </span>
                )}
              </span>
            </div>
          </div>
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
      <div className="nav-inline-header">
        <h2 className="section-title">Projects</h2>
        <span className="nav-count-badge">{sortedProjects.length}</span>
      </div>
      <ul className="project-list" aria-label="Active and recent project directories">
        {sortedProjects.map((project) => {
          const projectState = extractProjectState(project.statusLine)
          const projectStatus = parseProjectStatusLine(project.statusLine).slice(0, 1)
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
        })}
      </ul>
      {selectedProject ? (
        <>
          <div className="nav-inline-header nav-inline-header-sessions">
            <h2 className="section-title nav-section-title">Sessions</h2>
            <span className="nav-count-badge">{sortedSessions?.length ?? 0}</span>
          </div>
          <p className="nav-inline-project">
            {selectedProject.name} · {activeSessions?.length ?? 0} active ·{" "}
            {recentSessions?.length ?? 0} recent
          </p>
          {selectedProjectStatus.length > 0 ? (
            <div
              className="project-status-line nav-inline-status"
              title={selectedProject.statusLine}
            >
              {selectedProjectStatus.map((token) => (
                <span
                  key={`${selectedProject.cwd}-selected-${token.label}`}
                  className={cn("project-status-chip", `project-status-${token.tone}`)}
                >
                  {token.label}
                </span>
              ))}
            </div>
          ) : null}
          <ul className="session-list" aria-label="Sessions for selected project">
            {activeSessions && activeSessions.length > 0 ? (
              <li className="session-group-label">
                Active <span className="session-group-count">{activeSessions.length}</span>
              </li>
            ) : null}
            {activeSessions?.map(renderSessionRow)}
            {recentSessions && recentSessions.length > 0 ? (
              <li className="session-group-label">
                Recent <span className="session-group-count">{recentSessions.length}</span>
              </li>
            ) : null}
            {recentSessions?.map(renderSessionRow)}
          </ul>
        </>
      ) : (
        <p className="empty nav-empty-inline">Select a project to view sessions.</p>
      )}
    </nav>
  )
}
