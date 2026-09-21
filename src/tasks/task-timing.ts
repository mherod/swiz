export interface TaskTimingLike {
  status: string
  statusChangedAt?: string | null
  updatedAt?: string | null
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

/**
 * Epoch ms of the task's most recent recorded activity, preferring the
 * write-stamped `updatedAt` and falling back to the newest valid status,
 * start or completion timestamp for legacy records. Recency gates and
 * status-agnostic pruning share this definition. Returns null when the
 * record carries no usable timestamp, so callers can fail open.
 */
export function getTaskLastUpdatedMs(
  task: Pick<
    TaskTimingLike,
    "status" | "updatedAt" | "statusChangedAt" | "startedAt" | "completedAt"
  >
): number | null {
  const updatedAtMs = parseIsoTimestampMs(task.updatedAt)
  if (updatedAtMs !== null) return updatedAtMs
  const candidates = [
    parseIsoTimestampMs(task.statusChangedAt),
    isFiniteNumber(task.startedAt) ? task.startedAt : null,
    isFiniteNumber(task.completedAt) ? task.completedAt : null,
  ].filter((value): value is number => value !== null)
  return candidates.length === 0 ? null : Math.max(...candidates)
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
