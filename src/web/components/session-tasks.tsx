/**
 * The tasks view's two queues: the selected session, and the project around it.
 *
 * Both render through `TaskBoard`, so "ready" and "blocked" mean the same thing here as in the
 * MCP text board. The project queue additionally groups by store, because a project's tasks are
 * not one queue: the task store is dual-keyed (per session id, and per project key), and a flat
 * timestamp-ordered list silently interleaved a live session's work with a project-keyed backlog
 * and with throwaway test-session ids, which is exactly the confusion this view exists to remove.
 */

import { type ReactElement, useCallback, useMemo, useRef, useState } from "react"
import { projectKeyFromCwd } from "../../project-key.ts"
import { cn } from "../lib/cn.ts"
import { postJson } from "../lib/http.ts"
import type { ProjectTask, SessionTask, SessionTaskSummary } from "./session-browser-types.ts"
import { TaskBoard } from "./task-board.tsx"

/** Store groups rendered before the remainder collapses behind a button. */
const PREVIEW_GROUP_LIMIT = 4

async function postCancel(sessionId: string, taskId: string, cwd: string | null): Promise<void> {
  await postJson<{ taskId: string; status: string }>("/tasks/cancel", {
    sessionId,
    taskId,
    cwd: cwd ?? undefined,
  })
}

interface TaskCancellation {
  cancel: (storeKey: string, taskId: string) => void
  isPending: (storeKey: string, taskId: string) => boolean
  /** Applies confirmed cancellations the board has not been re-fetched for yet. */
  applyTo: <T extends SessionTask>(storeKey: string, tasks: T[]) => T[]
  error: string | null
}

/**
 * Re-status the tasks whose cancellation the server already confirmed.
 *
 * Keyed by store as well as id because task ids are unique only within a store: a bare id would
 * also strike the same-numbered row in every other session's board.
 */
export function applyConfirmedCancellations<T extends SessionTask>(
  storeKey: string,
  tasks: T[],
  cancelled: ReadonlySet<string>
): T[] {
  if (cancelled.size === 0) return tasks
  return tasks.map((task) =>
    cancelled.has(cancelKey(storeKey, task.id)) && task.status !== "cancelled"
      ? { ...task, status: "cancelled" as const }
      : task
  )
}

export function cancelKey(storeKey: string, taskId: string): string {
  return `${storeKey}\x00${taskId}`
}

/**
 * Owns the result of a cancel rather than waiting for the dashboard poll to show it.
 *
 * The poll cannot be relied on here: `useSessionPolling` returns early unless BOTH a project and
 * a session are selected, so on a project-only URL the board is fetched once and never again — a
 * confirmed cancel would sit invisible behind a spinner that never resolves. Applying the
 * confirmed status locally makes the mutation's result visible immediately, and surfacing the
 * error makes a failed one visible at all.
 */
function useTaskCancellation(cwd: string | null): TaskCancellation {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const cancel = useCallback(
    (storeKey: string, taskId: string) => {
      const key = cancelKey(storeKey, taskId)
      setError(null)
      setPending((prev) => new Set(prev).add(key))
      postCancel(storeKey, taskId, cwd)
        .then(() => setCancelled((prev) => new Set(prev).add(key)))
        .catch((err: unknown) => {
          setError(
            `Could not cancel #${taskId}: ${err instanceof Error ? err.message : "request failed"}`
          )
        })
        .finally(() =>
          setPending((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        )
    },
    [cwd]
  )

  const isPending = useCallback(
    (storeKey: string, taskId: string) => pending.has(cancelKey(storeKey, taskId)),
    [pending]
  )

  const applyTo = useCallback(
    <T extends SessionTask>(storeKey: string, tasks: T[]): T[] =>
      applyConfirmedCancellations(storeKey, tasks, cancelled),
    [cancelled]
  )

  return { cancel, isPending, applyTo, error }
}

function TaskCancelError({ error }: { error: string | null }): ReactElement | null {
  return error ? <p className="new-task-error">{error}</p> : null
}

export function SessionTasksSection({
  tasks,
  summary,
  loading,
  sessionId,
  cwd,
}: {
  tasks: SessionTask[]
  summary: SessionTaskSummary | null
  loading: boolean
  /** The store these tasks came from; without it a row has nothing to cancel against. */
  sessionId?: string | null
  cwd?: string | null
}): ReactElement {
  const cancellation = useTaskCancellation(cwd ?? null)
  const storeKey = sessionId ?? ""
  const handleCancel = useCallback(
    (taskId: string) => {
      if (storeKey) cancellation.cancel(storeKey, taskId)
    },
    [storeKey, cancellation]
  )
  const shownTasks = cancellation.applyTo(storeKey, tasks)

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
        <p className="empty">
          No tasks recorded for this session. Tasks appear once an agent starts work.
        </p>
      ) : (
        <>
          <TaskCancelError error={cancellation.error} />
          <TaskBoard
            tasks={shownTasks}
            onCancel={storeKey ? handleCancel : undefined}
            cancelPending={(taskId) => cancellation.isPending(storeKey, taskId)}
          />
        </>
      )}
    </section>
  )
}

interface TaskStoreGroup {
  /** The store key these tasks were read from — a session id, or the project key. */
  storeKey: string
  label: string
  /** True when this is the project-keyed store rather than one agent session. */
  isProjectStore: boolean
  tasks: ProjectTask[]
  openCount: number
  latestActivityMs: number
}

function storeLabel(storeKey: string, isProjectStore: boolean): string {
  if (isProjectStore) return "Project store (MCP tasks)"
  if (storeKey.length <= 16) return storeKey
  return `${storeKey.slice(0, 8)}…${storeKey.slice(-4)}`
}

function taskActivityMs(task: ProjectTask): number {
  const stamp = task.statusChangedAt ?? task.completionTimestamp
  if (!stamp) return 0
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Bucket project tasks by the store they came from, most active first.
 *
 * Ordering by open work rather than recency keeps the group a reader needs at the top: a store
 * with running or startable tasks matters more than one whose last event happens to be newer.
 */
export function groupTasksByStore(tasks: ProjectTask[], cwd: string | null): TaskStoreGroup[] {
  const projectKey = cwd ? projectKeyFromCwd(cwd) : null
  const groups = new Map<string, TaskStoreGroup>()
  for (const task of tasks) {
    const isProjectStore = projectKey !== null && task.sessionId === projectKey
    const existing = groups.get(task.sessionId)
    const group =
      existing ??
      ({
        storeKey: task.sessionId,
        label: storeLabel(task.sessionId, isProjectStore),
        isProjectStore,
        tasks: [],
        openCount: 0,
        latestActivityMs: 0,
      } satisfies TaskStoreGroup)
    group.tasks.push(task)
    if (task.status === "pending" || task.status === "in_progress") group.openCount += 1
    group.latestActivityMs = Math.max(group.latestActivityMs, taskActivityMs(task))
    if (!existing) groups.set(task.sessionId, group)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount
    if (a.isProjectStore !== b.isProjectStore) return a.isProjectStore ? -1 : 1
    return b.latestActivityMs - a.latestActivityMs
  })
}

function TaskStoreGroupCard({
  group,
  cancellation,
}: {
  group: TaskStoreGroup
  cancellation: TaskCancellation
}): ReactElement {
  const { storeKey } = group
  const handleCancel = useCallback(
    (taskId: string) => cancellation.cancel(storeKey, taskId),
    [storeKey, cancellation]
  )
  const shownTasks = cancellation.applyTo(storeKey, group.tasks)

  return (
    <details className="task-store-group" open={group.openCount > 0}>
      <summary className="task-store-summary">
        <span className="task-store-label">
          {group.label}
          {group.isProjectStore ? <span className="task-store-badge">project key</span> : null}
        </span>
        <span className="task-store-counts">
          {group.openCount} open · {group.tasks.length} total
        </span>
      </summary>
      <div className="task-store-body">
        <TaskBoard
          tasks={shownTasks}
          showHint={false}
          onCancel={handleCancel}
          cancelPending={(taskId) => cancellation.isPending(storeKey, taskId)}
        />
      </div>
    </details>
  )
}

function ProjectTaskGroups({
  tasks,
  cwd,
  loading,
}: {
  tasks: ProjectTask[]
  cwd: string | null
  loading: boolean
}): ReactElement {
  const [showAllGroups, setShowAllGroups] = useState(false)
  const cancellation = useTaskCancellation(cwd)
  const groups = useMemo(() => groupTasksByStore(tasks, cwd), [tasks, cwd])
  const visibleGroups = showAllGroups ? groups : groups.slice(0, PREVIEW_GROUP_LIMIT)
  const hiddenCount = groups.length - visibleGroups.length

  if (loading) return <p className="empty">Loading project tasks...</p>
  if (groups.length === 0) {
    return (
      <p className="empty">
        No tasks recorded for this project. Project history appears after task activity.
      </p>
    )
  }

  return (
    <>
      <p className="session-tasks-summary">
        {groups.length} task store{groups.length === 1 ? "" : "s"} in this project
      </p>
      <TaskCancelError error={cancellation.error} />
      {visibleGroups.map((group) => (
        <TaskStoreGroupCard key={group.storeKey} group={group} cancellation={cancellation} />
      ))}
      {hiddenCount > 0 || showAllGroups ? (
        <button
          type="button"
          className="task-show-more-btn w-full sm:w-auto text-center justify-center min-h-[36px] sm:min-h-0 mt-3"
          onClick={() => setShowAllGroups((value) => !value)}
        >
          {showAllGroups ? "Show fewer stores" : `Show ${hiddenCount} more task stores`}
        </button>
      ) : null}
    </>
  )
}

async function submitNewTask(
  sessionId: string,
  subject: string,
  cwd: string | null
): Promise<void> {
  await postJson<{ task: unknown }>("/tasks/create", {
    sessionId,
    subject,
    cwd: cwd ?? undefined,
  })
}

export function NewTaskForm({
  sessionId,
  cwd,
}: {
  sessionId: string | null
  cwd: string | null
}): ReactElement {
  const [subject, setSubject] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(
    (e: { preventDefault(): void }) => {
      e.preventDefault()
      const trimmed = subject.trim()
      if (!trimmed || !sessionId) return
      setSubmitting(true)
      setError(null)
      submitNewTask(sessionId, trimmed, cwd)
        .then(() => {
          setSubject("")
          inputRef.current?.focus()
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to create task")
        })
        .finally(() => setSubmitting(false))
    },
    [subject, sessionId, cwd]
  )

  if (!sessionId) return <p className="empty">Select a session to create tasks.</p>

  return (
    <form className="new-task-form" onSubmit={handleSubmit}>
      <div className="new-task-form-row">
        <input
          ref={inputRef}
          type="text"
          className="new-task-input"
          placeholder="New task subject…"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value)
            if (error) setError(null)
          }}
          disabled={submitting}
          aria-label="New task subject"
        />
        <button
          type="submit"
          className="new-task-submit"
          disabled={submitting || subject.trim().length === 0}
        >
          {submitting ? "…" : "+"}
        </button>
      </div>
      {error ? <p className="new-task-error">{error}</p> : null}
    </form>
  )
}

export function ProjectTasksSection({
  tasks,
  summary,
  loading,
  cwd,
}: {
  tasks: ProjectTask[]
  summary: SessionTaskSummary | null
  loading: boolean
  /** Used only to name the project-keyed store; omitting it leaves that group unlabelled. */
  cwd?: string | null
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section className="session-tasks-section" aria-label="All tasks for selected project">
      <div className="session-tasks-heading flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-2 mb-1">
        <h3 className="session-tasks-title">Project tasks</h3>
        <button
          type="button"
          className={cn(
            "task-collapse-btn w-full sm:w-auto text-center min-h-[32px] sm:min-h-0",
            collapsed && "active"
          )}
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
          {tasks.length < summary.total ? ` · showing latest ${tasks.length}` : ""}
        </p>
      ) : null}
      {collapsed ? null : <ProjectTaskGroups tasks={tasks} cwd={cwd ?? null} loading={loading} />}
    </section>
  )
}
