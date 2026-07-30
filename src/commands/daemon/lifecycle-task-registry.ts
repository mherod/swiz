export interface LifecycleTaskPayload {
  taskId: string
  subject: string
  description?: string
  teammateName?: string
  teamName?: string
}

export interface ActiveLifecycleTask extends LifecycleTaskPayload {
  createdAt: number
}

export const ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY = "_activeLifecycleTasks"

interface StoredLifecycleTask extends ActiveLifecycleTask {
  projectCwd: string
  sessionId: string
}

const DEFAULT_MAX_ACTIVE_TASKS = 500
const KEY_SEPARATOR = "\x00"

function nonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function taskKey(projectCwd: string, sessionId: string, taskId: string): string {
  return [projectCwd, sessionId, taskId].join(KEY_SEPARATOR)
}

function validCreatedTask(
  projectCwd: string,
  sessionId: string,
  task: LifecycleTaskPayload
): boolean {
  return [projectCwd, sessionId, task.taskId, task.subject].every(nonEmpty)
}

function storedLifecycleTask(
  projectCwd: string,
  sessionId: string,
  task: LifecycleTaskPayload,
  createdAt: number
): StoredLifecycleTask {
  const stored: StoredLifecycleTask = {
    projectCwd,
    sessionId,
    taskId: task.taskId,
    subject: task.subject,
    createdAt,
  }
  if (task.description) stored.description = task.description
  if (task.teammateName) stored.teammateName = task.teammateName
  if (task.teamName) stored.teamName = task.teamName
  return stored
}

export function formatLifecycleTaskAdvisory(tasks: ActiveLifecycleTask[]): string | null {
  if (tasks.length === 0) return null
  const taskLines = tasks.map((task) => {
    const owner = [task.teamName, task.teammateName].filter(Boolean).join("/")
    return `- ${task.taskId}: ${task.subject}${owner ? ` (${owner})` : ""}`
  })
  return [
    `${tasks.length} background lifecycle task${tasks.length === 1 ? " remains" : "s remain"} active (advisory only):`,
    ...taskLines,
  ].join("\n")
}

/**
 * Daemon-owned background-task lifecycle state.
 *
 * This registry is intentionally separate from planning/TODO task state. It is
 * updated before hook work enters the worker pool, so create/complete ordering
 * remains coherent across dispatch workers.
 */
export class LifecycleTaskRegistry {
  private readonly tasks = new Map<string, StoredLifecycleTask>()

  constructor(private readonly maxActiveTasks = DEFAULT_MAX_ACTIVE_TASKS) {}

  recordCreated(
    projectCwd: string,
    sessionId: string,
    task: LifecycleTaskPayload,
    createdAt = Date.now()
  ): boolean {
    if (!validCreatedTask(projectCwd, sessionId, task)) return false

    const key = taskKey(projectCwd, sessionId, task.taskId)
    const existing = this.tasks.get(key)
    this.evictOldestTaskIfFull(existing)
    this.tasks.set(
      key,
      storedLifecycleTask(projectCwd, sessionId, task, existing?.createdAt ?? createdAt)
    )
    return true
  }

  private evictOldestTaskIfFull(existing: StoredLifecycleTask | undefined): void {
    if (existing || this.tasks.size < this.maxActiveTasks) return
    const oldest = this.tasks.keys().next().value
    if (typeof oldest === "string") this.tasks.delete(oldest)
  }

  recordCompleted(projectCwd: string, sessionId: string, taskId: string): boolean {
    if (!nonEmpty(projectCwd) || !nonEmpty(sessionId) || !nonEmpty(taskId)) return false
    return this.tasks.delete(taskKey(projectCwd, sessionId, taskId))
  }

  listActive(projectCwd: string, sessionId: string): ActiveLifecycleTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.projectCwd === projectCwd && task.sessionId === sessionId)
      .sort(
        (left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)
      )
      .map(({ projectCwd: _projectCwd, sessionId: _sessionId, ...task }) => task)
  }

  clearProject(projectCwd: string): void {
    for (const [key, task] of this.tasks) {
      if (task.projectCwd === projectCwd) this.tasks.delete(key)
    }
  }

  clearProjectSession(projectCwd: string, sessionId: string): void {
    for (const [key, task] of this.tasks) {
      if (task.projectCwd === projectCwd && task.sessionId === sessionId) this.tasks.delete(key)
    }
  }

  clearSession(sessionId: string): void {
    for (const [key, task] of this.tasks) {
      if (task.sessionId === sessionId) this.tasks.delete(key)
    }
  }

  clear(): void {
    this.tasks.clear()
  }

  get size(): number {
    return this.tasks.size
  }
}
