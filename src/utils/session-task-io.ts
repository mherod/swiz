/**
 * Session task I/O: create a session-scoped task with sentinel-based dedup.
 *
 * Extracted from `hook-utils.ts` (#679) so the catch-all barrel shrinks toward
 * its focused clusters. `hook-utils.ts` re-exports `createSessionTask` so all
 * existing importers are unchanged. Keep this module free of imports from
 * `hook-utils.ts` to avoid a cycle — its deps (`debug`, `home`, `temp-paths`,
 * `hook-json-helpers`) do not import back, and `task-service` stays dynamic.
 */
import { join } from "node:path"
import { stderrLog } from "../debug.ts"
import { getHomeDirOrNull } from "../home.ts"
import { sessionTaskSentinelPath } from "../temp-paths.ts"
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

function sanitizePathComponent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "")
}

/** Validate session/sentinel inputs and check dedup sentinel. */
async function validateCreateTaskInputs(
  sessionId: string | undefined,
  sentinelKey: string
): Promise<{ safeSentinel: string; safeSession: string; sentinel: string } | null> {
  if (!isValidSessionId(sessionId) || !sentinelKey.trim()) return null
  const home = getHomeDirOrNull()
  if (!home) return null
  const safeSentinel = sanitizePathComponent(sentinelKey)
  const safeSession = sanitizePathComponent(sessionId)
  if (!safeSentinel || !safeSession) return null
  const sentinel = sessionTaskSentinelPath(safeSentinel, safeSession)
  if (await Bun.file(sentinel).exists()) return null
  return { safeSentinel, safeSession, sentinel }
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
 * Create a session task in-process with sentinel dedup.
 *
 * Calls `createTaskInProcess` directly — no subprocess overhead.
 * The `executor` parameter exists only for backward-compatible test injection;
 * when provided, it falls back to the legacy subprocess path.
 */
export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string,
  executor?: (args: string[]) => Promise<number>
): Promise<void> {
  const validated = await validateCreateTaskInputs(sessionId, sentinelKey)
  if (!validated) return
  const { sentinel } = validated

  // Legacy path: test-injected executor shells out to swiz CLI
  if (executor) {
    const exitCode = await executor(
      buildTaskCreateArgs("swiz", subject, description, sessionId ?? "")
    )
    if (exitCode === 0) await writeSentinel(sentinel)
    return
  }

  // In-process path: direct disk write, no subprocess
  try {
    const { createTaskInProcess } = await import("../tasks/task-service.ts")
    await createTaskInProcess({ sessionId: sessionId!, subject, description })
    await writeSentinel(sentinel)
  } catch (err) {
    stderrLog(
      "createSessionTask fallback",
      `[swiz] createSessionTask: in-process creation failed (${messageFromUnknownError(err)}), falling back to subprocess`
    )
    await createTaskViaSubprocess(subject, description, sessionId ?? "", sentinel)
  }
}
