import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { deadlineInputSchema } from "../../deadlines/model.ts"
import { DeadlineStore } from "../../deadlines/store.ts"
import { bindTaskDeadline, setTaskDeadline } from "../../deadlines/task-deadlines.ts"
import { resolveProjectRoot } from "../../project-identity.ts"
import { createDefaultTaskStore } from "../../task-roots.ts"
import { readTaskStore, readTaskStoreMeta, type Task } from "../../tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
  writeTaskUpdate,
} from "../../tasks/task-service.ts"
import { projectStoreKey, sessionStoreKey } from "../../tasks/task-store-path.ts"
import { getLockPathForFile, withFileLock } from "../../utils/file-lock.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import type { SessionRoutesContext } from "./session-routes.ts"

const cwdField = z.string().min(1).max(4096)
const statusField = z.enum(["pending", "in_progress", "completed", "cancelled"])
const createSchema = z.strictObject({
  cwd: cwdField,
  subject: z.string().trim().min(1).max(300),
  description: z.string().max(20000).default(""),
})
const statusSchema = z.strictObject({
  cwd: cwdField,
  storeId: z.string().min(1).max(4096),
  taskId: z.string().min(1).max(200),
  status: statusField,
  expectedStatus: statusField,
  expectedStatusChangedAt: z.string().nullable().optional(),
  evidence: z.string().trim().min(1).max(20000).optional(),
})
const deadlineSchema = deadlineInputSchema
  .omit({ sessionId: true, agentId: true, parentDeadlineId: true })
  .extend({ cwd: cwdField, action: z.enum(["set", "revise", "complete", "cancel"]) })
const taskCompletionSchema = statusSchema
  .omit({ status: true, evidence: true })
  .extend({ completed: z.boolean() })
const deadlineCompletionSchema = z.strictObject({
  cwd: cwdField,
  deadlineId: z.string().min(1).max(200),
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(1).max(200),
  completed: z.boolean(),
})
const dateFields = {
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string().min(1).max(100),
  dueAllDay: z.boolean(),
  requestId: z.string().min(1).max(200),
}
const taskIdentitySchema = statusSchema.omit({ status: true, evidence: true }).extend({
  expectedSubject: z.string(),
})
const taskTitleSchema = taskIdentitySchema.extend({ subject: z.string().trim().min(1).max(300) })
const taskDateSchema = taskIdentitySchema.extend({
  ...dateFields,
  expectedDeadlineId: z.string().nullable(),
  expectedRevision: z.number().int().positive().optional(),
})
const deadlineFieldsSchema = deadlineCompletionSchema
  .omit({ completed: true })
  .extend({
    label: z.string().trim().min(1).max(160).optional(),
    dueAt: dateFields.dueAt.optional(),
    timeZone: dateFields.timeZone.optional(),
    dueAllDay: dateFields.dueAllDay.optional(),
  })
  .refine(
    (input) => input.label !== undefined || input.dueAt !== undefined,
    "Supply title or due date"
  )

class WorkActionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function projectDirectory(body: unknown, ctx: SessionRoutesContext): Promise<string> {
  const { cwd } = z.object({ cwd: cwdField }).parse(body)
  if (!isAbsolute(cwd) || cwd.includes("\0") || !(await stat(cwd).catch(() => null))?.isDirectory())
    throw new WorkActionError("cwd must be an existing absolute project directory", 400)
  const root = await registerProjectAndTouch(ctx, cwd)
  if (!root || root === "/") throw new WorkActionError("A project directory is required", 400)
  return root
}

function taskChangeInput(body: unknown, fromReminders: boolean): z.infer<typeof statusSchema> {
  if (!fromReminders) return statusSchema.parse(body)
  const completion = taskCompletionSchema.parse(body)
  return {
    ...completion,
    status: completion.completed ? "completed" : "in_progress",
    evidence: "note: Marked complete in Apple Reminders by the user.",
  }
}

async function projectTask(input: { storeId: string; taskId: string }, cwd: string) {
  const tasksDir = createDefaultTaskStore().tasksDir
  const project = projectStoreKey(cwd)
  const storeKey = input.storeId === project.key ? project : sessionStoreKey(input.storeId)
  if (storeKey.kind === "session") {
    const meta = await readTaskStoreMeta(storeKey, tasksDir, true)
    if (!meta?.cwd || (await resolveProjectRoot(meta.cwd)) !== cwd)
      throw new WorkActionError("Task store does not belong to this project", 404)
  }
  const tasks = await readTaskStore(storeKey, tasksDir)
  const current = tasks.find((task) => task.id === input.taskId)
  if (!current) throw new WorkActionError("Task not found in this project store", 404)
  return { current, tasks, storeKey, tasksDir }
}

async function editTask(body: unknown, cwd: string, date: boolean) {
  const input = date ? taskDateSchema.parse(body) : taskTitleSchema.parse(body)
  const { current, storeKey, tasksDir } = await projectTask(input, cwd)
  if (
    current.subject !== input.expectedSubject ||
    current.status !== input.expectedStatus ||
    (current.statusChangedAt ?? null) !== (input.expectedStatusChangedAt ?? null)
  )
    throw new WorkActionError("Task edit conflict: refresh the latest task", 409)
  if (current.status === "cancelled")
    throw new WorkActionError("Cancelled tasks cannot be edited from Reminders", 409)
  if ("subject" in input) current.subject = input.subject
  else await editTaskDate(input, current, cwd, storeKey)
  const result = await writeTaskUpdate(storeKey, current.id, current, undefined, {
    filterCwd: cwd,
    tasksDir,
  })
  return { ok: true, task: result.task }
}

async function editTaskDate(
  input: z.infer<typeof taskDateSchema>,
  task: Task,
  cwd: string,
  storeKey: ReturnType<typeof projectStoreKey> | ReturnType<typeof sessionStoreKey>
) {
  if ((task.deadlineId ?? null) !== input.expectedDeadlineId)
    throw new WorkActionError("Task deadline conflict: refresh the latest task", 409)
  const store = (await DeadlineStore.open(undefined, true))!
  try {
    if (task.deadlineId) {
      if (!input.expectedRevision) throw new Error("expectedRevision is required")
      const identity = {
        deadlineId: task.deadlineId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
      }
      if (input.dueAt === null) {
        const old = store.get(task.deadlineId)
        if (old.status !== "completed")
          store.mutateProject(
            { ...identity, action: "cancel", reason: "Due date removed in Apple Reminders" },
            cwd
          )
        else if (old.revision !== input.expectedRevision) throw new Error("Revision conflict")
        delete task.deadlineId
      } else
        store.syncProjectFields(
          { ...identity, dueAt: input.dueAt, timeZone: input.timeZone, dueAllDay: input.dueAllDay },
          cwd
        )
      return
    }
  } finally {
    store.close()
  }
  if (input.dueAt === null) return
  const { deadline } = await setTaskDeadline(
    {
      sessionId: "project:reminders",
      requestId: input.requestId,
      dueAt: input.dueAt,
      dueAllDay: input.dueAllDay,
      timeZone: input.timeZone,
      reason: "Due date added in Apple Reminders",
    },
    cwd,
    task
  )
  await bindTaskDeadline(deadline.id, task.id, storeKey)
  task.deadlineId = deadline.id
}

async function changeTask(body: unknown, cwd: string, fromReminders = false) {
  const input = taskChangeInput(body, fromReminders)
  const { current, tasks, storeKey, tasksDir } = await projectTask(input, cwd)
  validateTaskChange(input, current, tasks)
  if (fromReminders && !validateReminderTransition(input, current, tasks))
    return { ok: true, task: current }
  const options = { filterCwd: cwd, tasksDir, evidence: input.evidence }
  const result =
    fromReminders && input.status === "completed"
      ? await completeTaskWithAutoTransition(storeKey, input.taskId, options)
      : await updateStatus(storeKey, input.taskId, input.status, options)
  return { ok: true, task: result.task }
}

function validateReminderTransition(
  input: z.infer<typeof statusSchema>,
  current: Task,
  tasks: Task[]
): boolean {
  if (current.status === "cancelled")
    throw new WorkActionError(
      "Cancelled tasks must be reopened in SwizBuzz before syncing completion",
      409
    )
  if (current.status === "pending" && input.status === "completed")
    validateTaskChange({ ...input, status: "in_progress" }, current, tasks)
  return (current.status === "completed") !== (input.status === "completed")
}

function validateTaskChange(input: z.infer<typeof statusSchema>, current: Task, tasks: Task[]) {
  if (
    current.status !== input.expectedStatus ||
    (current.statusChangedAt ?? null) !== (input.expectedStatusChangedAt ?? null)
  )
    throw new WorkActionError(
      "Task changed since this editor opened. Close and reopen it to review the latest status.",
      409
    )
  if (input.status === "completed" && !input.evidence)
    throw new WorkActionError("Completion evidence is required", 400)
  if (
    input.status === "in_progress" &&
    current.blockedBy.some((id) => {
      const blocker = tasks.find((task) => task.id === id)
      return !blocker || !["completed", "cancelled"].includes(blocker.status)
    })
  )
    throw new WorkActionError("Resolve the task's blockers before starting it", 409)
}

async function mutateWork(path: string, body: unknown, cwd: string) {
  if (path === "/work/deadlines/fields") {
    const { cwd: _cwd, ...input } = deadlineFieldsSchema.parse(body)
    if (input.dueAt === null)
      throw new Error(
        "A standalone deadline needs a due date. Restore its date in Reminders or cancel it in SwizBuzz."
      )
    const store = (await DeadlineStore.open(undefined, true))!
    try {
      return { ok: true, deadline: store.syncProjectFields({ ...input, dueAt: input.dueAt }, cwd) }
    } finally {
      store.close()
    }
  }
  if (path === "/work/deadlines/completion") {
    const { cwd: _cwd, ...input } = deadlineCompletionSchema.parse(body)
    const store = await DeadlineStore.open(undefined, true)
    if (!store) throw new Error("Unable to open deadline store")
    try {
      return { ok: true, deadline: store.syncProjectCompletion(input, cwd) }
    } finally {
      store.close()
    }
  }
  if (path === "/work/deadlines") {
    const { cwd: _cwd, ...input } = deadlineSchema.parse(body)
    const store = await DeadlineStore.open(undefined, true)
    if (!store) throw new Error("Unable to open deadline store")
    try {
      return { ok: true, deadline: store.mutateProject(input, cwd) }
    } finally {
      store.close()
    }
  }
  // Serialize dashboard writes to avoid duplicate IDs and competing status submissions.
  const lock = getLockPathForFile(
    `${createDefaultTaskStore().tasksDir}\0${projectStoreKey(cwd).key}\0work-actions`
  )
  return withFileLock(lock, async () => {
    if (path === "/work/tasks/status") return changeTask(body, cwd)
    if (path === "/work/tasks/completion") return changeTask(body, cwd, true)
    if (path === "/work/tasks/title") return editTask(body, cwd, false)
    if (path === "/work/tasks/date") return editTask(body, cwd, true)
    const input = createSchema.parse(body)
    const storeKey = projectStoreKey(cwd)
    const task = await createTaskInProcess({ ...input, cwd, storeKey, sessionId: storeKey.key })
    return { ok: true, task }
  })
}

export async function handleWorkActionRoutes(
  req: Request,
  url: URL,
  ctx: SessionRoutesContext
): Promise<Response | null> {
  if (
    ![
      "/work/tasks/create",
      "/work/tasks/status",
      "/work/deadlines",
      "/work/tasks/completion",
      "/work/deadlines/completion",
      "/work/deadlines/fields",
      "/work/tasks/title",
      "/work/tasks/date",
    ].includes(url.pathname)
  )
    return null
  if (req.method !== "POST")
    return Response.json(
      { error: "Use POST for work actions" },
      { status: 405, headers: { Allow: "POST" } }
    )
  try {
    const body: unknown = await req.json().catch(() => null)
    const cwd = await projectDirectory(body, ctx)
    return Response.json(await mutateWork(url.pathname, body, cwd))
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : "Unable to update project work"
    const status =
      error instanceof WorkActionError
        ? error.status
        : /conflict|already|Duplicate task|in.progress limit/i.test(message)
          ? 409
          : 400
    return Response.json({ error: message }, { status })
  }
}
