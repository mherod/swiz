import { useMemo, useState } from "react"
import { cn } from "../lib/cn.ts"
import type { ProjectTask, SessionTask, SessionTaskSummary } from "./session-browser-types.ts"
import { formatTime } from "./session-browser-utils.ts"

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

export function SessionTasksSection({
  tasks,
  summary,
  loading,
}: {
  tasks: SessionTask[]
  summary: SessionTaskSummary | null
  loading: boolean
}) {
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.status === "completed" || task.status === "cancelled"),
    [tasks]
  )
  const renderTaskRow = (task: SessionTask) => {
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
  }

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
        <>
          {openTasks.length > 0 ? (
            <ul className="session-task-list">{openTasks.map(renderTaskRow)}</ul>
          ) : (
            <p className="empty">No open tasks in this session.</p>
          )}
          {completedTasks.length > 0 ? (
            <details className="session-completed-tasks">
              <summary>Show completed ({completedTasks.length})</summary>
              <ul className="session-task-list">{completedTasks.map(renderTaskRow)}</ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

export function ProjectTasksSection({
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
