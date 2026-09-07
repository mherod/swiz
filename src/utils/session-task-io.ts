/**
 * Session task I/O: create a session-scoped task with sentinel-based dedup.
 *
 * Extracted from `hook-utils.ts` (#679) so the catch-all barrel shrinks toward
 * its focused clusters. `hook-utils.ts` re-exports `createSessionTask` so all
 * existing importers are unchanged. Keep this module free of imports from
 * `hook-utils.ts` to avoid a cycle — its deps (`debug`, `home`,
 * `hook-json-helpers`) do not import back, and `task-service` stays dynamic.
 */
import { join } from "node:path"
import { stderrLog } from "../debug.ts"
import { getHomeDirOrNull } from "../home.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import {
  isIncompleteTaskStatus,
  isSafeSessionId,
  mergeTaskStoresByRecency,
  readTasks,
  sessionDirPath,
  type TaskStatus,
  writeAudit,
  writeTask,
} from "../tasks/task-repository.ts"
import { messageFromUnknownError } from "./hook-json-helpers.ts"

const defaultTaskExecutor: (args: string[]) => Promise<number> = async (args) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode ?? 1
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== "null" && !!sessionId.trim()
}

/** Validate session/sentinel inputs and check dedup sentinel. */
async function validateCreateTaskInputs(
  sessionId: string | undefined,
  sentinelKey: string,
  storeKey: string
): Promise<{ sentinel: string } | null> {
  if (!isValidSessionId(sessionId) || !sentinelKey.trim()) return null
  const home = getHomeDirOrNull()
  if (!home) return null
  const { tasksDir } = createDefaultTaskStore()
  if (!isSafeSessionId(sessionId, tasksDir) || !isSafeSessionId(storeKey, tasksDir)) return null
  const digest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([sessionId, sentinelKey]))
    .digest("hex")
  const sentinel = join(sessionDirPath(storeKey, tasksDir), `.hook-dedup-${digest}.flag`)
  if (await Bun.file(sentinel).exists()) return null
  return { sentinel }
}

/** Write sentinel file to mark a task as already created. */
async function writeSentinel(sentinel: string): Promise<void> {
  try {
    await Bun.write(sentinel, "")
  } catch {}
}

/** Build the argv array for `swiz tasks create` subprocess calls. */
function buildTaskCreateArgs(
  swizBin: string,
  subject: string,
  description: string,
  sessionId: string
): string[] {
  return [swizBin, "tasks", "create", subject, description, "--session", sessionId]
}

/** Fallback: create task via subprocess when in-process import fails. */
async function createTaskViaSubprocess(
  subject: string,
  description: string,
  sessionId: string,
  sentinel: string
): Promise<void> {
  const home = getHomeDirOrNull()
  if (!home) return
  const swiz = Bun.which("swiz") ?? join(home, ".bun", "bin", "swiz")
  const exitCode = await defaultTaskExecutor(
    buildTaskCreateArgs(swiz, subject, description, sessionId)
  )
  if (exitCode === 0) await writeSentinel(sentinel)
}

/**
 * Create a hook task in the payload cwd's project store, matching MCP addressing.
 *
 * Calls `createTaskInProcess` directly — no subprocess overhead.
 * Pass the hook payload cwd explicitly: daemon process.cwd() can name another project.
 * The function-valued fifth argument preserves legacy executor injection; callers
 * without a cwd retain the session store.
 */
export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string,
  cwdOrExecutor?: string | ((args: string[]) => Promise<number>)
): Promise<void> {
  const cwd = typeof cwdOrExecutor === "string" ? cwdOrExecutor : undefined
  const storeKey = cwd ? projectKeyFromCwd(cwd) : (sessionId ?? "")
  const validated = await validateCreateTaskInputs(sessionId, sentinelKey, storeKey)
  if (!validated) return
  const { sentinel } = validated
  const executor = typeof cwdOrExecutor === "function" ? cwdOrExecutor : undefined

  // Legacy path: test-injected executor shells out to swiz CLI
  if (executor) {
    const exitCode = await executor(buildTaskCreateArgs("swiz", subject, description, storeKey))
    if (exitCode === 0) await writeSentinel(sentinel)
    return
  }

  // In-process path: direct disk write, no subprocess
  try {
    const { createTaskInProcess } = await import("../tasks/task-service.ts")
    await createTaskInProcess({ sessionId: storeKey, subject, description, cwd })
    await writeSentinel(sentinel)
  } catch (err) {
    stderrLog(
      "createSessionTask fallback",
      `[swiz] createSessionTask: in-process creation failed (${messageFromUnknownError(err)}), falling back to subprocess`
    )
    await createTaskViaSubprocess(subject, description, storeKey, sentinel)
  }
}

/**
 * Complete an incomplete session task selected by its exact subject.
 *
 * Stop hooks own the lifecycle of tasks they create. When their blocking
 * condition clears, this quiet in-process path closes the task without emitting
 * CLI output into hook stdout. Pending tasks transition through in_progress so
 * the task audit remains valid.
 */
export async function completeSessionTask(
  sessionId: string | undefined,
  subject: string,
  options: { cwd?: string; evidence: string }
): Promise<boolean> {
  if (!isValidSessionId(sessionId) || !subject.trim()) return false
  if (!isSafeSessionId(sessionId, createDefaultTaskStore().tasksDir)) return false

  const cwd = options.cwd ?? process.cwd()
  const storeKeys = [...new Set([sessionId, projectKeyFromCwd(cwd)])]
  const groups = await Promise.all(
    storeKeys.map(async (storeKey) =>
      (await readTasks(storeKey)).map((task) => ({ ...task, storeKey }))
    )
  )
  const match = mergeTaskStoresByRecency(...groups).find(
    (candidate) => candidate.subject === subject && isIncompleteTaskStatus(candidate.status)
  )
  if (!match) return false
  const { storeKey, ...task } = match

  const { applyStatusTransition } = await import("../tasks/task-service.ts")

  const transition = async (newStatus: TaskStatus): Promise<void> => {
    const oldStatus = task.status
    applyStatusTransition(task, newStatus)
    if (newStatus === "completed") {
      task.completionEvidence = options.evidence
    }
    await writeTask(storeKey, task, cwd)
    await writeAudit(storeKey, {
      timestamp: new Date().toISOString(),
      taskId: task.id,
      action: "status_change",
      oldStatus,
      newStatus,
      ...(newStatus === "completed" ? { evidence: options.evidence } : {}),
      subject: task.subject,
    })
  }

  if (task.status === "pending") await transition("in_progress")
  await transition("completed")
  return true
}
