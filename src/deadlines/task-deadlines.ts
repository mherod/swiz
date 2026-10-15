import { debugLog } from "../debug.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { readTaskStore, type Task, type TaskStoreKey } from "../tasks/task-repository.ts"
import {
  type Deadline,
  type DeadlineInput,
  renderDeadline,
  type TaskDeadlineInput,
  taskDeadlineSchema,
} from "./model.ts"
import { DeadlineStore } from "./store.ts"

type TaskDeadlineTarget = Pick<Task, "subject" | "description" | "activeForm" | "deadlineId"> & {
  id?: string
}

function taskDeadlineMutation(
  input: TaskDeadlineInput,
  task: TaskDeadlineTarget,
  previous?: Deadline
): DeadlineInput {
  if (previous?.status === "active") return { ...input, action: "revise", deadlineId: previous.id }
  return {
    ...input,
    action: "set",
    label: task.subject,
    completionCriteria: task.description || task.subject,
    parentDeadlineId: input.parentDeadlineId ?? previous?.parentDeadlineId,
  }
}

export async function setTaskDeadline(
  raw: TaskDeadlineInput,
  cwd: string,
  task: TaskDeadlineTarget,
  beforeMutation?: () => void
): Promise<{ deadline: Deadline; changed: boolean }> {
  const input = taskDeadlineSchema.parse(raw)
  const store = (await DeadlineStore.open(undefined, true))!
  try {
    const previous = task.deadlineId ? store.get(task.deadlineId) : undefined
    const deadline = store.mutate(
      taskDeadlineMutation(input, task, previous),
      cwd,
      Date.now(),
      "task",
      {
        operation: {
          input,
          task: task.id ?? {
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
          },
        },
        beforeMutation,
      }
    )
    await ensureBoundTaskExists(deadline)
    if (previous && deadline.id !== previous.id && deadline.status !== "active")
      throw new Error("This request refers to a closed, replaced deadline; use a new requestId")
    return {
      deadline,
      changed: deadline.id !== previous?.id || deadline.revision !== previous.revision,
    }
  } finally {
    store.close()
  }
}

async function ensureBoundTaskExists(deadline: Deadline): Promise<void> {
  if (!deadline.task) return
  const { storeKey, taskId, tasksDir } = deadline.task
  const tasks = await readTaskStore(storeKey, tasksDir)
  if (!tasks.some((task) => task.id === taskId))
    throw new Error(
      "The deadline's task is no longer in the queue; its history is retained. No replacement task was created."
    )
}

export async function bindTaskDeadline(
  deadlineId: string,
  taskId: string,
  storeKey: TaskStoreKey
): Promise<void> {
  const store = (await DeadlineStore.open(undefined, true))!
  try {
    store.bindTask(deadlineId, { storeKey, taskId, tasksDir: createDefaultTaskStore().tasksDir })
  } finally {
    store.close()
  }
}

/** A bounded task-tool projection; clock state lives in SQLite, never in task elapsed time. */
export async function renderTaskDeadlines(
  tasks: readonly Task[],
  highlightId?: string
): Promise<string> {
  const selected = tasks
    .filter(
      (task) =>
        task.deadlineId &&
        (task.id === highlightId || task.status === "pending" || task.status === "in_progress")
    )
    .sort((a, b) => Number(b.id === highlightId) - Number(a.id === highlightId))
  if (!selected.length) return ""
  let store: DeadlineStore | null
  try {
    store = await DeadlineStore.open()
  } catch {
    return "\n\nDeadline state unavailable; do not infer remaining time."
  }
  if (!store) return "\n\nDeadline state unavailable; do not infer remaining time."
  try {
    const now = Date.now()
    const lines = selected.slice(0, 8).map((task) => {
      try {
        return `#${task.id}: ${renderDeadline(store.get(task.deadlineId!), now)}`
      } catch {
        return `#${task.id}: deadline state unavailable.`
      }
    })
    if (selected.length > 8)
      lines.push(`${selected.length - 8} more task deadlines; use Deadline get for details.`)
    return `\n\nTask deadlines (checked ${new Date(now).toISOString()}):\n${lines.join("\n")}`
  } finally {
    store.close()
  }
}

export async function finishTaskDeadline(task: Task): Promise<void> {
  if (!task.deadlineId || (task.status !== "completed" && task.status !== "cancelled")) return
  let store: DeadlineStore | null = null
  try {
    store = await DeadlineStore.open(undefined, true)
    store!.finishTask(
      task.deadlineId,
      task.status,
      task.completionTimestamp ?? task.statusChangedAt ?? new Date().toISOString(),
      task.completionEvidence ?? task.description
    )
  } catch (error) {
    // The task is already persisted. Advisory clock failure must not undo or misreport that write.
    debugLog("[deadlines] could not reconcile task completion", error)
  } finally {
    store?.close()
  }
}
