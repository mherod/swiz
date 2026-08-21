/**
 * The task board — the queue drawn as a topology rather than a list.
 *
 * A flat, timestamp-ordered list answers "what tasks exist"; it cannot answer the questions a
 * dashboard is opened for: what is running right now, what could be started, what is stuck behind
 * something else, and which finish would free the most work. Those come from the `blockedBy` edges
 * and the timing fields, so this board groups by IN PROGRESS / READY / BLOCKED using the same
 * `task-topology` helpers the MCP text board uses — the browser and the terminal must not disagree
 * about what "ready" means.
 */

import type { ReactElement, ReactNode } from "react"
import { formatDuration } from "../../format-duration.ts"
import { getTaskCurrentDurationMs } from "../../tasks/task-timing.ts"
import {
  countTasksFreedBy,
  findDependencyCycle,
  indexTasksById,
  openBlockersOf,
  partitionTasks,
  pickCriticalPathTask,
  type TaskPartition,
} from "../../tasks/task-topology.ts"
import { cn } from "../lib/cn.ts"
import type { SessionTask } from "./session-browser-types.ts"
import { formatTime } from "./session-browser-utils.ts"

/** In-progress work older than this is called out as stalled — mirrors the MCP board. */
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000

type BoardGroupKey = "inProgress" | "ready" | "blocked" | "completed" | "cancelled"

const GROUP_LABELS: Record<BoardGroupKey, string> = {
  inProgress: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
}

/** Why a group exists, shown when it is empty so the absence reads as information. */
const GROUP_EMPTY_HINTS: Record<BoardGroupKey, string> = {
  inProgress: "Nothing is running.",
  ready: "Nothing can be started.",
  blocked: "Nothing is waiting on another task.",
  completed: "Nothing finished yet.",
  cancelled: "Nothing was cancelled.",
}

const DISTRIBUTION_ORDER: BoardGroupKey[] = [
  "inProgress",
  "ready",
  "blocked",
  "completed",
  "cancelled",
]

export function taskPartitionOf(tasks: readonly SessionTask[]): TaskPartition<SessionTask> {
  return partitionTasks(tasks)
}

function groupCount(partition: TaskPartition<SessionTask>, key: BoardGroupKey): number {
  return partition[key].length
}

/**
 * A proportional bar of the whole queue.
 *
 * The counts alone ("2 open · 174 completed") hide the ratio that actually characterises a queue —
 * a hundred completed tasks behind one blocked task is a very different picture from an even
 * split — so the same numbers are drawn to scale, with the counts kept as the accessible label.
 */
export function TaskDistributionBar({
  partition,
}: {
  partition: TaskPartition<SessionTask>
}): ReactElement | null {
  const segments = DISTRIBUTION_ORDER.map((key) => ({ key, count: groupCount(partition, key) }))
  const present = segments.filter((segment) => segment.count > 0)
  // One category is not a distribution: a full-width bar labelled "2 ready" reads as a progress
  // meter at 100% and tells the reader nothing the counts above it did not already say.
  if (present.length < 2) return null
  const label = segments
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${GROUP_LABELS[segment.key].toLowerCase()}`)
    .join(", ")

  return (
    <div className="task-distribution" role="img" aria-label={`Task distribution: ${label}`}>
      <div className="task-distribution-bar">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className={cn("task-distribution-segment", `task-distribution-${segment.key}`)}
              style={{ flexGrow: segment.count }}
              title={`${segment.count} ${GROUP_LABELS[segment.key].toLowerCase()}`}
            />
          ))}
      </div>
      <ul className="task-distribution-legend" aria-hidden="true">
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <li key={segment.key} className="task-distribution-legend-item">
              <span
                className={cn("task-distribution-dot", `task-distribution-${segment.key}`)}
                aria-hidden="true"
              />
              {segment.count} {GROUP_LABELS[segment.key].toLowerCase()}
            </li>
          ))}
      </ul>
    </div>
  )
}

/**
 * The single most useful sentence about the current queue, or null when it is simply moving.
 *
 * These are the states a reader cannot infer from the group counts: a deadlock reads as "all
 * blocked", and an empty ready column reads the same whether work is running or the queue is
 * exhausted.
 */
export function queueHintFor(tasks: readonly SessionTask[]): string | null {
  const { inProgress, ready, blocked } = partitionTasks(tasks)
  const cycle = findDependencyCycle(tasks)
  if (cycle) {
    const loop = [...cycle, cycle[0]].map((id) => `#${id}`).join(" → ")
    return `Dependency cycle: ${loop}. Nothing in this chain can start until one blockedBy edge is dropped.`
  }
  if (inProgress.length + ready.length + blocked.length === 0) return "No open tasks in this queue."
  const next = inProgress.length === 0 ? pickCriticalPathTask(ready, tasks) : null
  if (next) return `Nothing is running. Next up: #${next.id} — ${next.subject}`
  if (inProgress.length > 0 && ready.length === 0 && blocked.length > 0) {
    return `Every waiting task is blocked. Finishing #${inProgress[0]?.id} is what moves this queue.`
  }
  return null
}

function TaskStatusBadge({ status }: { status: SessionTask["status"] }): ReactElement {
  return (
    <span className={cn("task-status", `task-status-${status}`)}>{status.replace("_", " ")}</span>
  )
}

function TaskChecklistMark({ status }: { status: SessionTask["status"] }): ReactElement {
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

/** The edges and elapsed time for one task, as short chips beside its status. */
function TaskTopologyChips({
  task,
  tasks,
}: {
  task: SessionTask
  tasks: readonly SessionTask[]
}): ReactElement | null {
  const byId = indexTasksById(tasks)
  const blockers = openBlockersOf(task, byId)
  const freed = countTasksFreedBy(task, tasks, byId)
  const durationMs = getTaskCurrentDurationMs(task)
  const stalled = task.status === "in_progress" && durationMs >= STALE_IN_PROGRESS_MS

  const chips: ReactNode[] = []
  if (durationMs > 0) {
    chips.push(
      <span key="duration" className={cn("task-chip", stalled && "task-chip-warn")}>
        {task.status === "in_progress" ? "running " : ""}
        {formatDuration(durationMs)}
      </span>
    )
  }
  if (stalled) {
    chips.push(
      <span key="stalled" className="task-chip task-chip-warn">
        stalled — finish, split, or cancel
      </span>
    )
  }
  if (blockers.length > 0) {
    chips.push(
      <span key="blockers" className="task-chip task-chip-blocked">
        {task.status === "in_progress" ? "started while blocked by" : "blocked by"} #
        {blockers.join(", #")}
      </span>
    )
  }
  if (freed > 0) {
    chips.push(
      <span key="freed" className="task-chip task-chip-leverage">
        unblocks {freed}
      </span>
    )
  }
  if (chips.length === 0) return null
  return <div className="task-chips">{chips}</div>
}

/**
 * The evidence or description, but only when it says something the subject did not.
 *
 * A task created from a bare subject stores that same string as its description, and printing
 * both put the identical sentence on two consecutive lines of every such row.
 */
export function detailBeyondSubject(task: SessionTask): string | null {
  const detail = (task.completionEvidence ?? task.description)?.trim()
  if (!detail || detail === task.subject.trim()) return null
  return detail
}

/**
 * Cancel control for one open task.
 *
 * Only cancel, and only while the task is open: completion carries evidence and queue-depth
 * governance that a dashboard button has no way to satisfy honestly.
 *
 * The in-flight flag is owned by the caller, not this button. A button that tracks its own
 * spinner keeps spinning forever when the request fails, which is exactly what a stuck cancel
 * looked like: the click succeeded, nothing on screen changed, and there was no way to retry.
 */
function TaskCancelButton({
  task,
  pending,
  onCancel,
}: {
  task: SessionTask
  pending: boolean
  onCancel: (taskId: string) => void
}): ReactElement | null {
  if (task.status !== "pending" && task.status !== "in_progress") return null
  return (
    <button
      type="button"
      className="task-cancel-btn"
      disabled={pending}
      aria-label={`Cancel task ${task.id}: ${task.subject}`}
      onClick={() => onCancel(task.id)}
    >
      {pending ? "…" : "Cancel"}
    </button>
  )
}

export function TaskBoardRow({
  task,
  tasks,
  sessionLabel,
  onCancel,
  cancelPending,
}: {
  task: SessionTask
  tasks: readonly SessionTask[]
  sessionLabel?: string
  /** Omitted when the queue has no known store key to cancel against. */
  onCancel?: (taskId: string) => void
  cancelPending?: (taskId: string) => boolean
}): ReactElement {
  const taskTime = task.statusChangedAt ?? task.completionTimestamp
  const detail = detailBeyondSubject(task)
  return (
    <li className="session-task-row">
      <div className="session-task-meta flex-wrap sm:flex-nowrap gap-y-2">
        <span className="session-task-id truncate max-w-[75%] sm:max-w-none text-[0.65rem] sm:text-[0.7rem]">
          {sessionLabel ? `${sessionLabel} · ` : ""}#{task.id}
        </span>
        <span className="session-task-actions">
          {onCancel ? (
            <TaskCancelButton
              task={task}
              pending={cancelPending?.(task.id) ?? false}
              onCancel={onCancel}
            />
          ) : null}
          <TaskStatusBadge status={task.status} />
        </span>
      </div>
      <p className={cn("session-task-subject min-w-0", `session-task-subject-${task.status}`)}>
        <TaskChecklistMark status={task.status} />
        <span className="line-clamp-3 sm:line-clamp-none break-words flex-1">{task.subject}</span>
      </p>
      <TaskTopologyChips task={task} tasks={tasks} />
      {taskTime ? (
        <p className="session-task-time text-[0.65rem] sm:text-[0.68rem]">
          {formatTime(new Date(taskTime).getTime())}
        </p>
      ) : null}
      {detail ? (
        <p className="session-task-evidence line-clamp-2 sm:line-clamp-3 break-words text-[0.68rem] sm:text-[0.72rem]">
          {detail}
        </p>
      ) : null}
    </li>
  )
}

function TaskBoardGroup({
  groupKey,
  group,
  tasks,
  sessionLabelFor,
  showEmpty,
  collapsible,
  onCancel,
  cancelPending,
}: {
  groupKey: BoardGroupKey
  group: readonly SessionTask[]
  tasks: readonly SessionTask[]
  sessionLabelFor?: (task: SessionTask) => string | undefined
  showEmpty: boolean
  collapsible?: boolean
  onCancel?: (taskId: string) => void
  cancelPending?: (taskId: string) => boolean
}): ReactElement | null {
  if (group.length === 0 && !showEmpty) return null

  const heading = (
    <span className="task-group-heading">
      <span className={cn("task-group-dot", `task-distribution-${groupKey}`)} aria-hidden="true" />
      {GROUP_LABELS[groupKey]}
      <span className="task-group-count">{group.length}</span>
    </span>
  )

  const list =
    group.length === 0 ? (
      <p className="empty task-group-empty">{GROUP_EMPTY_HINTS[groupKey]}</p>
    ) : (
      <ul className="session-task-list">
        {group.map((task) => (
          <TaskBoardRow
            key={`${sessionLabelFor?.(task) ?? ""}:${task.id}`}
            task={task}
            tasks={tasks}
            sessionLabel={sessionLabelFor?.(task)}
            onCancel={onCancel}
            cancelPending={cancelPending}
          />
        ))}
      </ul>
    )

  if (collapsible && group.length > 0) {
    return (
      <details className="task-group task-group-collapsible">
        <summary className="task-group-summary">{heading}</summary>
        {list}
      </details>
    )
  }

  return (
    <section className="task-group" aria-label={GROUP_LABELS[groupKey]}>
      <div className="task-group-summary">{heading}</div>
      {list}
    </section>
  )
}

/**
 * The full board for one queue: distribution, hint, then the open groups.
 *
 * Open groups render even when empty — "Ready 0" next to "Blocked 3" is the diagnosis, and hiding
 * the empty column is what made the old flat list unreadable. Finished work stays collapsed
 * because it is history, not topology.
 */
export function TaskBoard({
  tasks,
  sessionLabelFor,
  showHint = true,
  onCancel,
  cancelPending,
}: {
  tasks: readonly SessionTask[]
  sessionLabelFor?: (task: SessionTask) => string | undefined
  /** Off for a board nested inside a store group: the page already states the queue's next move. */
  showHint?: boolean
  /** Omitted when the queue has no known store key to cancel against. */
  onCancel?: (taskId: string) => void
  cancelPending?: (taskId: string) => boolean
}): ReactElement {
  const partition = partitionTasks(tasks)
  const hint = showHint ? queueHintFor(tasks) : null

  return (
    <div className="task-board">
      <TaskDistributionBar partition={partition} />
      {hint ? <p className="task-queue-hint">{hint}</p> : null}
      {(["inProgress", "ready", "blocked"] as const).map((key) => (
        <TaskBoardGroup
          key={key}
          groupKey={key}
          group={partition[key]}
          tasks={tasks}
          sessionLabelFor={sessionLabelFor}
          onCancel={onCancel}
          cancelPending={cancelPending}
          showEmpty
        />
      ))}
      {(["completed", "cancelled"] as const).map((key) => (
        <TaskBoardGroup
          key={key}
          groupKey={key}
          group={partition[key]}
          tasks={tasks}
          sessionLabelFor={sessionLabelFor}
          onCancel={onCancel}
          cancelPending={cancelPending}
          showEmpty={false}
          collapsible
        />
      ))}
    </div>
  )
}
