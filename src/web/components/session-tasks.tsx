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
}): React.ReactElement {
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.status === "completed" || task.status === "cancelled"),
    [tasks]
  )

  return (
    <section className="session-tasks-section" aria-label="Current tasks for selected session">
      <h3 className="session-tasks-title mb-2">Session tasks</h3>
      {summary ? (
        <p className="session-tasks-summary mb-3 sm:mb-2 mt-1">
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
            <ul className="session-task-list">
              {openTasks.map((task) => (
                <SessionTaskRow key={task.id} task={task} />
              ))}
            </ul>
          ) : (
            <p className="empty">No open tasks in this session.</p>
          )}
          {completedTasks.length > 0 ? (
            <details className="session-completed-tasks mt-3">
              <summary className="py-2 sm:py-0 min-h-[32px] sm:min-h-0 flex items-center w-full">
                Show completed ({completedTasks.length})
              </summary>
              <ul className="session-task-list mt-2">
                {completedTasks.map((task) => (
                  <SessionTaskRow key={task.id} task={task} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

function ProjectTaskRow({ task }: { task: ProjectTask }) {
  const taskTime = task.statusChangedAt ?? task.completionTimestamp
  return (
    <li key={`${task.sessionId}:${task.id}`} className="session-task-row">
      <div className="session-task-meta flex-wrap sm:flex-nowrap gap-y-2">
        <span className="session-task-id truncate max-w-[75%] sm:max-w-none text-[0.65rem] sm:text-[0.7rem]">
          {task.sessionId.slice(0, 8)}... · #{task.id}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className={cn("session-task-subject min-w-0", `session-task-subject-${task.status}`)}>
        <TaskChecklistMark status={task.status} />
        <span className="line-clamp-3 sm:line-clamp-none break-words flex-1">{task.subject}</span>
      </p>
      {taskTime ? (
        <p className="session-task-time text-[0.65rem] sm:text-[0.68rem]">
          {formatTime(new Date(taskTime).getTime())}
        </p>
      ) : null}
    </li>
  )
}

function SessionTaskRow({ task }: { task: SessionTask }) {
  const taskTime = task.statusChangedAt ?? task.completionTimestamp
  return (
    <li key={task.id} className="session-task-row">
      <div className="session-task-meta flex-wrap sm:flex-nowrap gap-y-2">
        <span className="session-task-id truncate max-w-[75%] sm:max-w-none text-[0.65rem] sm:text-[0.7rem]">
          #{task.id}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className={cn("session-task-subject min-w-0", `session-task-subject-${task.status}`)}>
        <TaskChecklistMark status={task.status} />
        <span className="line-clamp-3 sm:line-clamp-none break-words flex-1">{task.subject}</span>
      </p>
      {taskTime ? (
        <p className="session-task-time text-[0.65rem] sm:text-[0.68rem]">
          {formatTime(new Date(taskTime).getTime())}
        </p>
      ) : null}
      {task.completionEvidence ? (
        <p className="session-task-evidence line-clamp-2 sm:line-clamp-none break-words text-[0.68rem] sm:text-[0.72rem]">
          {task.completionEvidence}
        </p>
      ) : null}
    </li>
  )
}

function ProjectTaskListControls({
  visibility,
  openTasks,
  tasks,
  setVisibility,
  setExpanded,
}: {
  visibility: "open" | "all"
  openTasks: ProjectTask[]
  tasks: ProjectTask[]
  setVisibility: (v: "open" | "all") => void
  setExpanded: (v: boolean) => void
}): React.ReactElement {
  return (
    <div className="session-task-controls flex flex-col sm:flex-row gap-2.5 sm:gap-2 mb-3 sm:mb-2.5 mt-2.5">
      <button
        type="button"
        className={cn(
          "task-filter-btn w-full sm:w-auto text-center justify-center min-h-[32px] sm:min-h-0",
          visibility === "open" && "active"
        )}
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
        className={cn(
          "task-filter-btn w-full sm:w-auto text-center justify-center min-h-[32px] sm:min-h-0",
          visibility === "all" && "active"
        )}
        onClick={() => {
          setVisibility("all")
          setExpanded(false)
        }}
        aria-pressed={visibility === "all"}
      >
        All ({tasks.length} loaded)
      </button>
    </div>
  )
}

function ProjectTaskEmptyState({ visibility }: { visibility: "open" | "all" }) {
  return visibility === "open" ? (
    <p className="empty">No open tasks in this project.</p>
  ) : (
    <p className="empty">No tasks recorded for this project.</p>
  )
}

function ProjectTaskList({
  tasks,
  scopedTasks,
  summary,
  openTasks,
  visibility,
  setVisibility,
  loading,
}: {
  tasks: ProjectTask[]
  scopedTasks: ProjectTask[]
  summary: SessionTaskSummary | null
  openTasks: ProjectTask[]
  visibility: "open" | "all"
  setVisibility: (v: "open" | "all") => void
  loading: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const previewLimit = 16
  const visibleTasks = expanded ? scopedTasks : scopedTasks.slice(0, previewLimit)
  const hiddenCount = Math.max(scopedTasks.length - visibleTasks.length, 0)

  return (
    <>
      <ProjectTaskListControls
        visibility={visibility}
        openTasks={openTasks}
        tasks={tasks}
        setVisibility={setVisibility}
        setExpanded={setExpanded}
      />
      {summary && tasks.length < summary.total ? (
        <p className="session-tasks-summary">
          Showing latest {tasks.length} of {summary.total} tasks.
        </p>
      ) : null}
      {loading ? (
        <p className="empty">Loading project tasks...</p>
      ) : scopedTasks.length === 0 ? (
        <ProjectTaskEmptyState visibility={visibility} />
      ) : (
        <>
          <ul className="session-task-list">
            {visibleTasks.map((task) => (
              <ProjectTaskRow key={`${task.sessionId}:${task.id}`} task={task} />
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="task-show-more-btn w-full sm:w-auto text-center justify-center min-h-[36px] sm:min-h-0 mt-3"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer tasks" : `Show ${hiddenCount} more tasks`}
            </button>
          ) : null}
        </>
      )}
    </>
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
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const scopedTasks = visibility === "open" ? openTasks : tasks

  return (
    <section className="session-tasks-section" aria-label="All tasks for selected project">
      <div className="session-tasks-heading flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-2 mb-1">
        <h3 className="session-tasks-title">Project tasks</h3>
        <button
          type="button"
          className="task-collapse-btn w-full sm:w-auto text-center min-h-[32px] sm:min-h-0"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {summary ? (
        <p className="session-tasks-summary mb-3 sm:mb-2 mt-1">
          {summary.total} total · {summary.open} open · {summary.completed} completed ·{" "}
          {summary.cancelled} cancelled
        </p>
      ) : null}
      {collapsed ? null : (
        <ProjectTaskList
          tasks={tasks}
          scopedTasks={scopedTasks}
          summary={summary}
          openTasks={openTasks}
          visibility={visibility}
          setVisibility={setVisibility}
          loading={loading}
        />
      )}
    </section>
  )
}
