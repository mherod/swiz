const HEALTHY_PENDING_TASK_BUFFER = 2

interface TaskBufferEntry {
  status: string
  subject?: string
}

export function countPendingTasks(tasks: ReadonlyArray<TaskBufferEntry>): number {
  return tasks.filter((task) => task.status === "pending").length
}

export function hasHealthyPendingTaskBuffer(tasks: ReadonlyArray<TaskBufferEntry>): boolean {
  return countPendingTasks(tasks) >= HEALTHY_PENDING_TASK_BUFFER
}

export function hasHealthyTaskBuffer(tasks: ReadonlyArray<TaskBufferEntry>): boolean {
  return hasHealthyPendingTaskBuffer(tasks) && tasks.some((task) => task.status === "in_progress")
}

export function hadHealthyPendingTaskBufferBeforeTaskCreate(
  tasks: ReadonlyArray<TaskBufferEntry>,
  createdSubject: string
): boolean {
  let pendingCount = 0
  let createdTaskSeen = false

  for (const task of tasks) {
    if (task.status !== "pending") continue
    pendingCount++
    if (!createdTaskSeen && task.subject === createdSubject) {
      createdTaskSeen = true
    }
  }

  return pendingCount - (createdTaskSeen ? 1 : 0) >= HEALTHY_PENDING_TASK_BUFFER
}
