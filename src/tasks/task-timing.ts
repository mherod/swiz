export interface TaskTimingLike {
  status: string
  statusChangedAt?: string | null
  completionTimestamp?: string | null
  startedAt?: number | null
  completedAt?: number | null
  elapsedMs?: number | null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function parseIsoTimestampMs(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function getTaskStartedAtMs(
  task: Pick<TaskTimingLike, "status" | "startedAt" | "statusChangedAt">
): number | null {
  if (isFiniteNumber(task.startedAt)) return task.startedAt
  if (task.status === "in_progress") return parseIsoTimestampMs(task.statusChangedAt)
  return null
}

export function getTaskCompletedAtMs(
  task: Pick<TaskTimingLike, "status" | "completedAt" | "completionTimestamp" | "statusChangedAt">
): number | null {
  if (isFiniteNumber(task.completedAt)) return task.completedAt
  const completionTimestampMs = parseIsoTimestampMs(task.completionTimestamp)
  if (completionTimestampMs !== null) return completionTimestampMs
  if (task.status === "completed") return parseIsoTimestampMs(task.statusChangedAt)
  return null
}

export function getTaskCurrentDurationMs(
  task: Pick<TaskTimingLike, "status" | "elapsedMs" | "startedAt" | "statusChangedAt">,
  nowMs = Date.now()
): number {
  const baseElapsedMs = isFiniteNumber(task.elapsedMs) ? task.elapsedMs : 0
  if (task.status !== "in_progress") return Math.max(0, baseElapsedMs)

  const startedAtMs = getTaskStartedAtMs(task)
  if (startedAtMs === null) return Math.max(0, baseElapsedMs)

  return Math.max(0, baseElapsedMs + Math.max(0, nowMs - startedAtMs))
}

export function backfillTaskTimingFields<T extends TaskTimingLike>(
  task: T,
  fileMtimeMs?: number
): T {
  const fallbackStatusChangedAtMs =
    parseIsoTimestampMs(task.statusChangedAt) ??
    (typeof fileMtimeMs === "number" && Number.isFinite(fileMtimeMs) ? fileMtimeMs : null)

  if (task.startedAt === undefined) {
    task.startedAt = task.status === "in_progress" ? fallbackStatusChangedAtMs : null
  } else if (!isFiniteNumber(task.startedAt)) {
    task.startedAt = null
  }

  if (task.completedAt === undefined) {
    task.completedAt = getTaskCompletedAtMs(task)
  } else if (!isFiniteNumber(task.completedAt)) {
    task.completedAt = null
  }

  if (!isFiniteNumber(task.elapsedMs)) {
    task.elapsedMs = 0
  }

  return task
}
