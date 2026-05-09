export interface TaskSubjectEntry {
  id: string
  subject: string
  status?: string
}

export interface DuplicateSubjectGroup {
  normalizedSubject: string
  subject: string
  tasks: TaskSubjectEntry[]
}

const DUPLICATE_SUBJECT_STATUSES = new Set(["pending", "in_progress"])

export function normalizeTaskSubjectForDuplicate(subject: string): string {
  return subject.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}

export function isDuplicateSubjectCandidate(task: TaskSubjectEntry): boolean {
  return (
    task.id.length > 0 &&
    task.subject.trim().length > 0 &&
    DUPLICATE_SUBJECT_STATUSES.has(task.status ?? "pending")
  )
}

export function findDuplicateSubjectGroups(
  tasks: ReadonlyArray<TaskSubjectEntry>
): DuplicateSubjectGroup[] {
  const bySubject = new Map<string, DuplicateSubjectGroup>()

  for (const task of tasks) {
    if (!isDuplicateSubjectCandidate(task)) continue
    const normalizedSubject = normalizeTaskSubjectForDuplicate(task.subject)
    if (!normalizedSubject) continue

    const existing = bySubject.get(normalizedSubject)
    if (existing) {
      existing.tasks.push({ id: task.id, subject: task.subject, status: task.status })
    } else {
      bySubject.set(normalizedSubject, {
        normalizedSubject,
        subject: task.subject.trim(),
        tasks: [{ id: task.id, subject: task.subject, status: task.status }],
      })
    }
  }

  return [...bySubject.values()]
    .filter((group) => group.tasks.length > 1)
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      ),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject))
}

export function duplicateSubjectSeverity(groups: ReadonlyArray<DuplicateSubjectGroup>): number {
  return groups.reduce((total, group) => total + Math.max(0, group.tasks.length - 1), 0)
}

export function findDuplicateSubjectCollision(
  subject: string,
  tasks: ReadonlyArray<TaskSubjectEntry>,
  excludeTaskId?: string
): TaskSubjectEntry | null {
  const normalizedSubject = normalizeTaskSubjectForDuplicate(subject)
  if (!normalizedSubject) return null

  return (
    tasks.find(
      (task) =>
        task.id !== excludeTaskId &&
        isDuplicateSubjectCandidate(task) &&
        normalizeTaskSubjectForDuplicate(task.subject) === normalizedSubject
    ) ?? null
  )
}

export function formatDuplicateSubjectGroups(groups: ReadonlyArray<DuplicateSubjectGroup>): string {
  return groups
    .map((group) => {
      const taskList = group.tasks
        .map((task) => `#${task.id}${task.status ? ` (${task.status})` : ""}`)
        .join(", ")
      return `  - "${group.subject}" is on ${taskList}`
    })
    .join("\n")
}

export function taskIdIsInDuplicateGroups(
  taskId: string,
  groups: ReadonlyArray<DuplicateSubjectGroup>
): boolean {
  return groups.some((group) => group.tasks.some((task) => task.id === taskId))
}

export function applyTaskUpdatePreview(
  tasks: ReadonlyArray<TaskSubjectEntry>,
  taskId: string,
  updates: { status?: string; subject?: string }
): TaskSubjectEntry[] {
  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: updates.status ?? task.status,
          subject: updates.subject ?? task.subject,
        }
      : { ...task }
  )
}
