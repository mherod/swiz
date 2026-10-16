import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { deadlineInputSchema } from "../../deadlines/model.ts"
import { DeadlineStore } from "../../deadlines/store.ts"
import { resolveProjectRoot } from "../../project-identity.ts"
import { createDefaultTaskStore } from "../../task-roots.ts"
import { readTaskStore, readTaskStoreMeta, type Task } from "../../tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
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

async function projectTask(input: z.infer<typeof statusSchema>, cwd: string) {
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
