import { basename, join } from "node:path"
import { createDefaultTaskStore } from "../task-roots.ts"
import { readAuditLog } from "../tasks/task-audit-verification.ts"
import { isSessionTaskJsonFile } from "../tasks/task-file-utils.ts"
import {
  legacySessionPrefix,
  parseTaskId,
  readTasks,
  sessionDirPath,
  sessionPrefix,
} from "../tasks/task-repository.ts"
import { getSessions } from "../tasks/task-resolver.ts"

const RECOVERY_MUTATIONS = new Set(["complete", "status", "update", "repair"])
const LIST_FLAGS = new Set([
  "--session",
  "--all-sessions",
  "--recovered",
  "--all-projects",
  "--date-format",
])

function recoveryCommand(args: string[]): string | undefined {
  const first = args[0]
  if (!first || LIST_FLAGS.has(first)) return undefined
  if (RECOVERY_MUTATIONS.has(first)) return first
  throw new Error(
    `Unsupported recovery command: ${first}. Use list, complete, status, update, or repair.`
  )
}

function sessionArgumentIndex(args: string[], mutation: boolean): number {
  const positions = args.flatMap((arg, index) => (arg === "--session" ? [index] : []))
  if (positions.length > 1) {
    throw new Error("Task recovery requires exactly one --session value.")
  }
  const index = positions[0] ?? -1
  if (index < 0) {
    if (mutation) throw new Error("Task recovery mutations require an explicit --session <id>.")
    if (!args.includes("--all-sessions") && !args.includes("--recovered")) {
      throw new Error(
        "Task recovery listing requires --session <id>, --all-sessions, or --recovered."
      )
    }
    return index
  }
  const value = args[index + 1]
  if (!value?.trim() || value.startsWith("-")) {
    throw new Error("Task recovery requires a nonempty --session <id> value.")
  }
  return index
}

async function resolveRecoverySession(prefix: string): Promise<string> {
  const matches = (await getSessions()).filter((sessionId) => sessionId.startsWith(prefix))
  if (matches.length === 0) throw new Error(`Recovery session "${prefix}" not found.`)
  if (matches.length > 1) {
    throw new Error(
      `Recovery session prefix "${prefix}" is ambiguous. Use a full --session ID: ${matches.join(", ")}`
    )
  }
  return matches[0]!
}

function requestedTaskIds(args: string[], command: string): string[] {
  if (command === "repair") return []
  const rest = args.slice(1)
  const firstFlag = rest.findIndex((arg) => arg.startsWith("--"))
  const positionals = firstFlag === -1 ? rest : rest.slice(0, firstFlag)
  const taskIds = command === "update" ? positionals : positionals.slice(0, 1)
  if (taskIds.length === 0 || taskIds.some((id) => !id.trim() || id.startsWith("-"))) {
    throw new Error(`Task recovery ${command} requires an existing task ID before its options.`)
  }
  return taskIds
}

function assertRecoveryTaskId(sessionId: string, taskId: unknown): asserts taskId is string {
  if (
    typeof taskId !== "string" ||
    !taskId.trim() ||
    taskId !== basename(taskId) ||
    taskId.includes("\\") ||
    taskId.includes("\0") ||
    !isSessionTaskJsonFile(`${taskId}.json`)
  ) {
    throw new Error(
      `Unsafe recovery task ID ${JSON.stringify(taskId)} in session "${sessionId}". Task IDs must be single task filename components.`
    )
  }
  const { prefix } = parseTaskId(taskId)
  if (
    prefix !== null &&
    prefix !== sessionPrefix(sessionId) &&
    prefix !== legacySessionPrefix(sessionId)
  ) {
    throw new Error(
      `Task #${taskId} has a prefix that does not match recovery session "${sessionId}". Recovery cannot route a task to another session.`
    )
  }
}

async function assertMatchingTaskFile(directory: string, sessionId: string, taskId: string) {
  const record: unknown = await Bun.file(join(directory, `${taskId}.json`))
    .json()
    .catch(() => null)
  if (!record || typeof record !== "object" || Reflect.get(record, "id") !== taskId) {
    throw new Error(
      `Task #${taskId} requires a matching task file in recovery session "${sessionId}". Use scoped repair to restore audited records before mutating them.`
    )
  }
}

async function assertSelectedSessionTasks(sessionId: string, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) assertRecoveryTaskId(sessionId, taskId)
  const tasks = await readTasks(sessionId)
  const existingIds = new Set(tasks.map((task) => task.id))
  const directory = sessionDirPath(sessionId, createDefaultTaskStore().tasksDir)
  for (const taskId of taskIds) {
    if (!existingIds.has(taskId)) {
      throw new Error(
        `Task #${taskId} does not exist in recovery session "${sessionId}". Recovery does not search other sessions; scoped repair can restore audited records.`
      )
    }
    await assertMatchingTaskFile(directory, sessionId, taskId)
  }
}

async function assertRepairAuditIds(sessionId: string): Promise<void> {
  for (const entry of await readAuditLog(sessionId)) {
    assertRecoveryTaskId(sessionId, entry?.taskId)
  }
}

/** Validate arguments after `recover` before reusing the existing scoped task handlers. */
export async function resolveTaskRecoveryArgs(args: string[]): Promise<string[]> {
  const normalized = args[0] === "list" ? args.slice(1) : [...args]
  const command = recoveryCommand(normalized)
  const sessionIndex = sessionArgumentIndex(normalized, command !== undefined)
  if (sessionIndex < 0) return normalized

  const sessionId = await resolveRecoverySession(normalized[sessionIndex + 1]!)
  normalized[sessionIndex + 1] = sessionId
  if (command === "repair") {
    await assertRepairAuditIds(sessionId)
  } else if (command) {
    const taskIds = requestedTaskIds(normalized, command)
    if (taskIds.length > 0) await assertSelectedSessionTasks(sessionId, taskIds)
  }
  return normalized
}
