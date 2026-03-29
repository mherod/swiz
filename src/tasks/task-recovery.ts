import { join } from "node:path"
import { orderBy } from "lodash-es"
import { getHomeDirWithFallback } from "../home.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { backfillTaskTimingFields } from "./task-timing.ts"

/**
 * Canonical shape for a task file stored in ~/.claude/tasks/<session-id>/<id>.json.
 * All fields except id/subject/status are optional so callers that only need
 * the minimal shape don't have to cast.
 */
export interface SessionTask {
  id: string
  subject: string
  status: string
  description?: string
  activeForm?: string
  blocks?: string[]
  blockedBy?: string[]
  completionEvidence?: string
  completionTimestamp?: string
  statusChangedAt?: string
  elapsedMs?: number
  startedAt?: number | null
  completedAt?: number | null
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

/** Resolve ~/.claude/tasks for the active home directory. */
export function getTasksRoot(home: string = getHomeDirWithFallback("")): string | null {
  if (!home) return null
  return join(home, ".claude", "tasks")
}

/** Resolve ~/.claude/projects for the active home directory. */
export function getProjectsRoot(home: string = getHomeDirWithFallback("")): string | null {
  if (!home) return null
  return join(home, ".claude", "projects")
}

/** Resolve ~/.claude/tasks/<sessionId> for the active home directory. */
export function getSessionTasksDir(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksRoot = getTasksRoot(home)
  if (!tasksRoot || !sessionId) return null
  return join(tasksRoot, sessionId)
}

/** Resolve ~/.claude/tasks/<sessionId>/<taskId>.json for task file access. */
export function getSessionTaskPath(
  sessionId: string,
  taskId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir || !taskId) return null
  return join(tasksDir, `${taskId}.json`)
}

/** Resolve ~/.claude/tasks/<sessionId>/compact-snapshot.json. */
export function getSessionCompactSnapshotPath(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null
  return join(tasksDir, "compact-snapshot.json")
}

/** True when a session task directory exists and can be listed. */
export async function hasSessionTasksDir(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<boolean> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return false
  try {
    const { readdir } = await import("node:fs/promises")
    await readdir(tasksDir)
    return true
  } catch {
    return false
  }
}

/**
 * Read all task files for a session from ~/.claude/tasks/<sessionId>/.
 * Returns an empty array when the directory doesn't exist or can't be read.
 * Skips files that fail to parse or don't end with .json.
 */
async function readTaskFile(tasksDir: string, fileName: string): Promise<SessionTask | null> {
  if (!fileName.endsWith(".json") || fileName.startsWith(".")) return null
  try {
    const task = (await Bun.file(join(tasksDir, fileName)).json()) as SessionTask
    if (task.id && task.subject && task.status) {
      // Backfill fingerprint for tasks that predate the field
      if (!task.subjectFingerprint) {
        task.subjectFingerprint = computeSubjectFingerprint(task.subject)
      }
      backfillTaskTimingFields(task)
      return task
    }
  } catch {
    // skip unreadable or malformed task files
  }
  return null
}

export async function readSessionTasks(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<SessionTask[]> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return []
  let files: string[]
  try {
    const { readdir } = await import("node:fs/promises")
    files = await readdir(tasksDir)
  } catch {
    return []
  }
  const tasks: SessionTask[] = []
  for (const f of files) {
    const task = await readTaskFile(tasksDir, f)
    if (task) tasks.push(task)
  }
  // Sort tasks by ID to ensure deterministic output
  return orderBy(tasks, [(t) => t.id], ["asc"])
}

/**
 * Result of scanning prior sessions for incomplete tasks.
 * Includes the session ID so callers can construct `swiz tasks complete --session` commands.
 */
export interface PriorSessionResult {
  sessionId: string
  tasks: SessionTask[]
}

export interface LimitedItems<T> {
  visible: T[]
  remaining: number
}

/** Limit repeated context items so hook output stays bounded. */
export function limitItems<T>(items: T[], limit = 3): LimitedItems<T> {
  if (limit <= 0) return { visible: [], remaining: items.length }
  const visible = items.slice(0, limit)
  return {
    visible,
    remaining: Math.max(items.length - visible.length, 0),
  }
}

/**
 * Find incomplete tasks from the most recent prior session for a given project.
 *
 * Scans ~/.claude/projects/<projectKey>/ for session transcript IDs, then checks
 * ~/.claude/tasks/<sessionId>/ for incomplete tasks (pending | in_progress).
 * Returns tasks from the most recently-modified session that has any tasks,
 * excluding `excludeSessionId` (the current session).
 */
async function collectSessionsFromTranscripts(
  projectDir: string,
  excludeSessionId: string
): Promise<{ id: string; mtime: number }[]> {
  const { readdir, stat } = await import("node:fs/promises")
  let transcriptFiles: string[]
  try {
    transcriptFiles = await readdir(projectDir)
  } catch {
    return []
  }

  const sessions: { id: string; mtime: number }[] = []
  for (const f of transcriptFiles) {
    if (!f.endsWith(".jsonl")) continue
    const id = f.slice(0, -6)
    if (id === excludeSessionId) continue
    try {
      const s = await stat(join(projectDir, f))
      sessions.push({ id, mtime: s.mtimeMs })
    } catch {}
  }
  return orderBy(sessions, [(session) => session.mtime], ["desc"])
}

export async function findPriorSessionTasks(
  cwd: string,
  excludeSessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<PriorSessionResult | null> {
  if (!home || !cwd) return null
  const { projectKeyFromCwd } = await import("../transcript-utils.ts")

  const projectKey = projectKeyFromCwd(cwd)
  const projectsRoot = getProjectsRoot(home)
  if (!projectsRoot) return null
  const projectDir = join(projectsRoot, projectKey)

  const orderedSessions = await collectSessionsFromTranscripts(projectDir, excludeSessionId)

  // Walk sessions newest-first; return incomplete tasks from first session with tasks
  for (const { id } of orderedSessions) {
    const tasks = await readSessionTasks(id, home)
    const incomplete = tasks
      .filter((t) => isIncompleteTaskStatus(t.status))
      // Filter to only numeric IDs (user-created tasks), excluding legacy prefixed placeholders
      .filter((t) => /^\d+$/.test(t.id))
    if (incomplete.length > 0) return { sessionId: id, tasks: incomplete }
  }
  return null
}

/** True when a task status counts as incomplete work. */
export function isIncompleteTaskStatus(status: string): boolean {
  return status === "pending" || status === "in_progress"
}

/**
 * Format task subjects for denial messages.
 * Uses active task lines when present; otherwise falls back to all tasks.
 */
export function formatTaskSubjectsForDisplay(
  allTasks: SessionTask[],
  activeTaskSubjects: string[]
): string {
  const displayTasks =
    activeTaskSubjects.length > 0
      ? activeTaskSubjects
      : allTasks.map((t) => `#${t.id} (${t.status}): ${t.subject}`)
  return displayTasks.map((t) => `  ${t}`).join("\n")
}

export interface FormatTaskListOptions {
  limit?: number
  overflowLabel?: string
  indent?: string
  subjectMaxLength?: number
}

function truncateTaskSubject(subject: string, maxLength: number | undefined): string {
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) return subject
  const safeMax = Math.max(0, Math.floor(maxLength))
  if (safeMax === 0) return ""
  if (subject.length <= safeMax) return subject
  if (safeMax <= 3) return subject.slice(0, safeMax)
  return `${subject.slice(0, safeMax - 3)}...`
}

/**
 * Render tasks as a bullet list, optionally capped with an overflow line.
 * Useful for hook messages that need bounded context.
 */
export function formatTaskList(
  tasks: Array<Pick<SessionTask, "id" | "status" | "subject">>,
  options: FormatTaskListOptions = {}
): string {
  if (tasks.length === 0) return ""
  const indent = options.indent ?? "  "
  const limit = options.limit ?? tasks.length
  const subjectMaxLength = options.subjectMaxLength
  const { visible, remaining } = limitItems(tasks, limit)
  const lines = visible
    .map(
      (t) =>
        `${indent}• #${t.id} [${t.status}]: ${truncateTaskSubject(t.subject, subjectMaxLength)}`
    )
    .join("\n")
  if (remaining === 0) return lines
  const overflowLabel = options.overflowLabel ?? "task(s)"
  return `${lines}\n${indent}... ${remaining} more ${overflowLabel}`
}

/**
 * Render a single `swiz tasks complete` command.
 * Pass `<id>` when showing a template rather than a concrete task command.
 */
export function formatTaskCompleteCommand(
  taskId: string,
  sessionId: string,
  evidence: string,
  options: { indent?: string } = {}
): string {
  const indent = options.indent ?? ""
  return `${indent}swiz tasks complete ${taskId} --session ${sessionId} --evidence "${evidence}"`
}

/** Render one `swiz tasks complete` command per task. */
export function formatTaskCompleteCommands(
  tasks: Array<Pick<SessionTask, "id">>,
  sessionId: string,
  evidence: string,
  options: { indent?: string } = {}
): string {
  return tasks
    .map((t) => formatTaskCompleteCommand(String(t.id), sessionId, evidence, options))
    .join("\n")
}

/** Strict task file shape with all timing fields required — used by builders. */
export type TaskFile = Required<
  Pick<
    SessionTask,
    | "id"
    | "subject"
    | "description"
    | "status"
    | "statusChangedAt"
    | "elapsedMs"
    | "startedAt"
    | "completedAt"
  >
> &
  Pick<SessionTask, "activeForm" | "completionTimestamp"> & {
    blocks: string[]
    blockedBy: string[]
  }
