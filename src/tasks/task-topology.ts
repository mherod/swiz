/**
 * Task dependency topology — the shape of the queue, independent of how it is drawn.
 *
 * The MCP tools render this as text for an agent and the daemon web dashboard renders it as a
 * board for a human, and the two must not drift: "ready", "blocked", and "unblocks N" have to mean
 * the same thing in the terminal and in the browser. The helpers therefore live here, typed
 * against the minimal `{ id, status, blockedBy }` shape both callers can satisfy, rather than
 * against the on-disk `Task` record — the web preview payload is deliberately narrower.
 *
 * Everything in this module is pure and browser-safe: no filesystem, no clock beyond an injected
 * `nowMs`, no Node builtins.
 */

/** The minimum a task must expose for its position in the dependency graph to be computed. */
export interface TopologyTask {
  id: string
  status: string
  blockedBy: readonly string[]
}

export function isOpenStatus(status: string): boolean {
  return status === "pending" || status === "in_progress"
}

export function indexTasksById<T extends { id: string }>(
  tasks: readonly T[]
): ReadonlyMap<string, T> {
  return new Map(tasks.map((task) => [task.id, task]))
}

/**
 * The blockers of `task` that are still open.
 *
 * A `blockedBy` id with no matching task counts as not blocking: the edge may point at another
 * session's task, and guessing "blocked" there would leave the task permanently stuck in the view.
 * Both sides of the before/after comparison apply the same rule, so an unknown edge can never
 * fabricate an unblock event.
 */
export function openBlockersOf<T extends TopologyTask>(
  task: T,
  byId: ReadonlyMap<string, T>
): string[] {
  return task.blockedBy.filter((id) => {
    const blocker = byId.get(id)
    return blocker !== undefined && isOpenStatus(blocker.status)
  })
}

export function isBlocked<T extends TopologyTask>(task: T, byId: ReadonlyMap<string, T>): boolean {
  return openBlockersOf(task, byId).length > 0
}

/**
 * How many still-open tasks this task is the last blocker for — its leverage.
 *
 * Counting only tasks whose *sole* remaining blocker is this one keeps the number honest:
 * "unblocks 2" then means finishing this task really does free two tasks, not that two tasks
 * mention it among several blockers and stay stuck anyway.
 */
export function countTasksFreedBy<T extends TopologyTask>(
  task: T,
  tasks: readonly T[],
  byId: ReadonlyMap<string, T>
): number {
  return tasks.filter((candidate) => {
    if (!isOpenStatus(candidate.status)) return false
    const blockers = openBlockersOf(candidate, byId)
    return blockers.length === 1 && blockers[0] === task.id
  }).length
}

/**
 * The first dependency cycle among open tasks, as the ids on the loop.
 *
 * A cycle is a deadlock the status view cannot show: every task on it is "blocked", none can ever
 * start, and the caller keeps looking for something to do. Edges to finished tasks are ignored,
 * so only live deadlocks are reported.
 */
export function findDependencyCycle<T extends TopologyTask>(tasks: readonly T[]): string[] | null {
  const byId = indexTasksById(tasks)
  const open = tasks.filter((task) => isOpenStatus(task.status))
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []

  const visit = (task: T): string[] | null => {
    const mark = state.get(task.id)
    if (mark === "done") return null
    if (mark === "visiting") return stack.slice(stack.indexOf(task.id))
    state.set(task.id, "visiting")
    stack.push(task.id)
    for (const blockerId of openBlockersOf(task, byId)) {
      const blocker = byId.get(blockerId)
      if (!blocker) continue
      const cycle = visit(blocker)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(task.id, "done")
    return null
  }

  for (const task of open) {
    const cycle = visit(task)
    if (cycle) return cycle
  }
  return null
}

/**
 * Tasks that were waiting on a blocker before the update and are now free to start.
 *
 * This is the payoff of completing a task and the one thing the caller cannot see from the status
 * change alone — the freed task lives further down the list, and its `blockedBy` edge still names
 * the (now completed) blocker.
 */
export function findNewlyUnblockedTasks<T extends TopologyTask>(
  before: readonly T[],
  after: readonly T[]
): T[] {
  const beforeById = indexTasksById(before)
  const afterById = indexTasksById(after)
  return after.filter((task) => {
    if (!isOpenStatus(task.status)) return false
    const previous = beforeById.get(task.id)
    if (!previous) return false
    return isBlocked(previous, beforeById) && !isBlocked(task, afterById)
  })
}

/**
 * Open work split by whether it can actually be started right now.
 *
 * `pending` is not one queue: a pending task with an open blocker cannot be picked up, and showing
 * it alongside startable work is what makes a long queue unreadable. Completed and cancelled
 * tasks are returned untouched so a caller can render or count them without a second pass.
 */
export interface TaskPartition<T> {
  inProgress: T[]
  ready: T[]
  blocked: T[]
  completed: T[]
  cancelled: T[]
}

/**
 * Among startable tasks, the one that frees the most downstream work.
 *
 * Ties keep queue order, so an ordinary flat queue with no edges still recommends the oldest ready
 * task rather than an arbitrary one.
 */
export function pickCriticalPathTask<T extends TopologyTask>(
  ready: readonly T[],
  tasks: readonly T[]
): T | null {
  if (ready.length === 0) return null
  const byId = indexTasksById(tasks)
  return ready.reduce((best, candidate) =>
    countTasksFreedBy(candidate, tasks, byId) > countTasksFreedBy(best, tasks, byId)
      ? candidate
      : best
  )
}

export function partitionTasks<T extends TopologyTask>(tasks: readonly T[]): TaskPartition<T> {
  const byId = indexTasksById(tasks)
  const partition: TaskPartition<T> = {
    inProgress: [],
    ready: [],
    blocked: [],
    completed: [],
    cancelled: [],
  }
  for (const task of tasks) {
    if (task.status === "in_progress") partition.inProgress.push(task)
    else if (task.status === "pending")
      (isBlocked(task, byId) ? partition.blocked : partition.ready).push(task)
    else if (task.status === "completed") partition.completed.push(task)
    else if (task.status === "cancelled") partition.cancelled.push(task)
  }
  return partition
}
