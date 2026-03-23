import { readdir, readFile, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { DIM, GREEN, RESET } from "../ansi.ts"
import {
  PROJECT_STATES,
  type ProjectState,
  readProjectState,
  STATE_TRANSITIONS,
  writeProjectState,
} from "../settings.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { validateEvidence, verifyCiGreenEvidence, verifyTaskSubject } from "./evidence-validator.ts"
import {
  compareTaskIds,
  parseTaskId,
  readTasks,
  STATUS_STYLE,
  sessionPrefix,
  type Task,
  writeAudit,
  writeTask,
} from "./task-repository.ts"
import { collectIncompleteTasks, getOrphanSessionIds, resolveTaskById } from "./task-resolver.ts"

export { compareTaskIds, parseTaskId, sessionPrefix }

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function createTask(sessionId: string, subject: string, description: string) {
  const tasks = await readTasks(sessionId)
  const prefix = sessionPrefix(sessionId)
  const maxSeq = tasks.reduce((m, t) => {
    const parsed = parseTaskId(t.id)
    const seq = parsed.prefix === prefix || parsed.prefix === null ? parsed.seq : 0
    return Math.max(m, Number.isNaN(seq) ? 0 : seq)
  }, 0)
  const id = `${prefix}-${maxSeq + 1}`

  const task: Task = {
    id,
    subject,
    description,
    status: "pending",
    startedAt: null,
    completedAt: null,
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    subjectFingerprint: computeSubjectFingerprint(subject),
    blocks: [],
    blockedBy: [],
  }

  await writeTask(sessionId, task, process.cwd())
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId: id,
    action: "create",
    newStatus: "pending",
    subject,
  })

  const { emoji, color } = STATUS_STYLE.pending
  console.log(`\n  ${emoji} Created #${id}: ${color}pending${RESET}`)
  console.log(`     ${subject}\n`)
}

export interface EnsureFileBackedTaskOptions {
  sessionId: string
  taskId: string
  filterCwd?: string
  subject?: string
  description?: string
  activeForm?: string
  status?: Task["status"]
  allowPlaceholderSubject?: boolean
}

function buildStubTask(
  taskId: string,
  subject: string,
  opts: Pick<EnsureFileBackedTaskOptions, "description" | "activeForm" | "status">
): Task {
  const status = opts.status ?? "in_progress"
  return {
    id: taskId,
    subject,
    description: opts.description ?? subject,
    activeForm: opts.activeForm,
    status,
    startedAt: status === "in_progress" ? Date.now() : null,
    completedAt: status === "completed" ? Date.now() : null,
    ...(status === "completed" ? { completionTimestamp: new Date().toISOString() } : {}),
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    blocks: [],
    blockedBy: [],
  }
}

async function isTaskMissing(
  sessionId: string,
  taskId: string,
  filterCwd?: string
): Promise<boolean> {
  try {
    await resolveTaskById(taskId, sessionId, filterCwd)
    return false
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) return true
    throw error
  }
}

/** Max sessions to scan when recovering task subjects from audit logs. */
const AUDIT_RECOVERY_MAX_SESSIONS = 10

/**
 * Scan recent audit logs to recover a task's original subject.
 * Searches the most recently modified session audit logs for a non-placeholder
 * `create` entry matching the given taskId. This recovers metadata lost when
 * tasks created by the native TaskCreate tool survive compaction but their
 * file-store entries are in a session directory that's no longer resolvable.
 */
function isValidRecoveredSubject(entry: unknown, taskId: string): entry is Record<string, unknown> {
  if (typeof entry !== "object" || !entry) return false
  const e = entry as Record<string, unknown>
  const subject = e.subject
  return (
    e.taskId === taskId &&
    e.action === "create" &&
    typeof subject === "string" &&
    subject.length > 0 &&
    !subject.startsWith("Task #") &&
    !subject.startsWith("Recovered task #")
  )
}

async function collectSessionMtimes(tasksDir: string): Promise<{ dir: string; mtime: number }[]> {
  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(tasksDir)
  } catch {
    return []
  }

  const withMtime: { dir: string; mtime: number }[] = []
  for (const dir of sessionDirs) {
    try {
      const { mtimeMs } = await stat(join(tasksDir, dir, ".audit-log.jsonl"))
      withMtime.push({ dir, mtime: mtimeMs })
    } catch {}
  }
  withMtime.sort((a, b) => b.mtime - a.mtime)
  return withMtime
}

function tryParseAuditEntry(line: string, taskId: string): string | null {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>
    if (!isValidRecoveredSubject(entry, taskId)) return null
    return typeof entry.subject === "string" ? entry.subject : null
  } catch {
    return null
  }
}

async function searchAuditLogForTask(auditPath: string, taskId: string): Promise<string | null> {
  try {
    const content = await readFile(auditPath, "utf-8")
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      const subject = tryParseAuditEntry(line, taskId)
      if (subject) return subject
    }
  } catch {}
  return null
}

async function recoverSubjectFromAuditLogs(
  taskId: string,
  tasksDir: string
): Promise<string | null> {
  const withMtime = await collectSessionMtimes(tasksDir)
  for (const { dir } of withMtime.slice(0, AUDIT_RECOVERY_MAX_SESSIONS)) {
    const auditPath = join(tasksDir, dir, ".audit-log.jsonl")
    const subject = await searchAuditLogForTask(auditPath, taskId)
    if (subject) return subject
  }
  return null
}

export async function ensureFileBackedTask({
  sessionId,
  taskId,
  filterCwd,
  subject,
  description,
  activeForm,
  status = "in_progress",
  allowPlaceholderSubject = false,
}: EnsureFileBackedTaskOptions): Promise<boolean> {
  if (!(await isTaskMissing(sessionId, taskId, filterCwd))) return false

  // Before falling back to a placeholder, try to recover the original subject
  // from audit logs across all sessions (handles compaction boundary gaps).
  let resolvedSubject = subject
  let source = "from --subject"
  if (!resolvedSubject) {
    const { tasksDir } = createDefaultTaskStore()
    const auditSubject = await recoverSubjectFromAuditLogs(taskId, tasksDir)
    if (auditSubject) {
      resolvedSubject = auditSubject
      source = "recovered from audit log"
    }
  }

  const finalSubject = resolvedSubject ?? (allowPlaceholderSubject ? `Task #${taskId}` : null)
  if (!finalSubject) return false

  if (!resolvedSubject && allowPlaceholderSubject) {
    source = "using task ID as placeholder"
  }

  const stubTask = buildStubTask(taskId, finalSubject, { description, activeForm, status })
  await writeTask(sessionId, stubTask, process.cwd())
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "create",
    newStatus: stubTask.status,
    subject: finalSubject,
  })

  console.log(`  ℹ️  Task #${taskId} not in file store — created stub (${source})`)
  return true
}

const VALID_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "pending", "cancelled"]),
  completed: new Set(["in_progress"]),
  cancelled: new Set(["pending", "in_progress"]),
}

export function validateTransition(oldStatus: string, newStatus: string): string | null {
  if (oldStatus === newStatus) return null
  const allowed = VALID_TRANSITIONS[oldStatus]
  if (!allowed || !allowed.has(newStatus)) {
    return `Invalid transition: ${oldStatus} → ${newStatus}. Tasks must be in_progress before they can be completed.`
  }
  return null
}

function applyTaskTimestamps(
  task: Task,
  newStatus: Task["status"],
  nowIso: string,
  nowMs: number
): void {
  if (task.startedAt === undefined) task.startedAt = null
  if (task.completedAt === undefined) task.completedAt = null
  if (newStatus === "in_progress") task.startedAt = nowMs
  if (newStatus === "completed") {
    task.completedAt = nowMs
    if (!task.completionTimestamp) task.completionTimestamp = nowIso
  }
}

export function applyStatusTransition(
  task: Task,
  newStatus: Task["status"],
  nowIso = new Date().toISOString(),
  nowMs = Date.now()
): void {
  const error = validateTransition(task.status, newStatus)
  if (error) throw new Error(error)

  if (task.status === "in_progress" && task.statusChangedAt) {
    const elapsed = nowMs - new Date(task.statusChangedAt).getTime()
    task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, elapsed)
  }

  task.status = newStatus
  task.statusChangedAt = nowIso
  applyTaskTimestamps(task, newStatus, nowIso, nowMs)
}

async function validateAndVerifyEvidence(evidence: string | undefined): Promise<void> {
  if (!evidence) return
  const validationError = validateEvidence(evidence)
  if (validationError) throw new Error(validationError)
  const ciError = await verifyCiGreenEvidence(evidence, process.cwd())
  if (ciError) throw new Error(ciError)
}

export async function updateStatus(
  sessionId: string,
  taskId: string,
  newStatus: Task["status"],
  options: {
    evidence?: string
    verifyText?: string
    filterCwd?: string
  } = {}
) {
  const { evidence, verifyText, filterCwd } = options
  const { sessionId: effectiveSessionId, task } = await resolveTaskById(
    taskId,
    sessionId,
    filterCwd
  )

  if (verifyText) {
    const verifyError = verifyTaskSubject(task.subject, verifyText)
    if (verifyError) throw new Error(verifyError)
  }

  if (newStatus === "completed" && !evidence) {
    throw new Error("Evidence required when completing a task. Use --evidence.")
  }

  await validateAndVerifyEvidence(evidence)

  const oldStatus = task.status
  const now = new Date().toISOString()
  const nowMs = Date.now()

  applyStatusTransition(task, newStatus, now, nowMs)
  if (newStatus === "completed" && evidence) {
    task.completionEvidence = evidence
    task.completionTimestamp = now
  }

  await writeTask(effectiveSessionId, task, process.cwd())
  await writeAudit(effectiveSessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "status_change",
    oldStatus,
    newStatus,
    evidence,
    subject: task.subject,
  })

  const { emoji, color } = STATUS_STYLE[newStatus]
  console.log(`\n  ${emoji} #${taskId}: ${oldStatus} → ${color}${newStatus}${RESET}`)
  console.log(`     ${task.subject}`)
  if (evidence) console.log(`     ${DIM}Evidence: ${evidence}${RESET}`)
  console.log()
}

export async function completeAll(targetSessionId: string, filterCwd?: string, evidence?: string) {
  const resolvedEvidence = evidence ?? "note:bulk-complete — conclusion: all tasks completed"
  const evidenceError = validateEvidence(resolvedEvidence)
  if (evidenceError) throw new Error(evidenceError)

  const ciError = await verifyCiGreenEvidence(resolvedEvidence, process.cwd())
  if (ciError) throw new Error(ciError)

  const incomplete = (await collectIncompleteTasks(filterCwd)).filter(
    ({ sessionId }) => sessionId === targetSessionId
  )

  if (incomplete.length === 0) {
    console.log("\n  No incomplete tasks.\n")
    return
  }

  console.log(
    `\n  Completing ${incomplete.length} task(s) across ${new Set(incomplete.map((i) => i.sessionId)).size} session(s)...\n`
  )
  for (const { task } of incomplete) {
    // Transition through in_progress if still pending
    if (task.status === "pending") {
      await updateStatus(targetSessionId, task.id, "in_progress", { filterCwd })
    }
    await updateStatus(targetSessionId, task.id, "completed", {
      evidence: resolvedEvidence,
      filterCwd,
    })
  }
}

// ─── Adopt ────────────────────────────────────────────────────────────────────

/**
 * Re-associate all tasks from orphan (compaction-gap) sessions into the given
 * target session.
 */
export async function adoptOrphanedTasks(targetSessionId: string, cwd: string): Promise<void> {
  const orphanIds = await getOrphanSessionIds()
  if (orphanIds.size === 0) {
    console.log("\n  No recovered sessions to adopt.\n")
    return
  }

  const { tasksDir } = createDefaultTaskStore()
  const prefix = sessionPrefix(targetSessionId)

  const existing = await readTasks(targetSessionId)
  let maxSeq = existing.reduce((m, t) => {
    const parsed = parseTaskId(t.id)
    const seq = parsed.prefix === prefix || parsed.prefix === null ? parsed.seq : 0
    return Math.max(m, Number.isNaN(seq) ? 0 : seq)
  }, 0)

  const existingFingerprints = new Set(
    existing.map((t) => t.subjectFingerprint ?? computeSubjectFingerprint(t.subject))
  )

  let adopted = 0
  let skipped = 0

  for (const orphanSessionId of orphanIds) {
    const tasks = await readTasks(orphanSessionId)
    if (tasks.length === 0) continue

    for (const task of tasks) {
      const fp = task.subjectFingerprint ?? computeSubjectFingerprint(task.subject)
      if (existingFingerprints.has(fp)) {
        console.log(`  ${DIM}⚠ Skipped #${task.id} (duplicate subject): ${task.subject}${RESET}`)
        skipped++
        continue
      }
      existingFingerprints.add(fp)
      maxSeq++
      const newId = `${prefix}-${maxSeq}`
      const adoptedTask: Task = { ...task, id: newId }
      await writeTask(targetSessionId, adoptedTask, cwd)
      await writeAudit(targetSessionId, {
        timestamp: new Date().toISOString(),
        taskId: newId,
        action: "create",
        newStatus: adoptedTask.status,
        subject: adoptedTask.subject,
        verificationText: `adopted from orphan session ${orphanSessionId.slice(0, 8)}`,
      })
      try {
        await unlink(join(tasksDir, orphanSessionId, `${task.id}.json`))
      } catch {}
      console.log(
        `  ${GREEN}✓${RESET} Adopted #${newId} ${DIM}(was ${task.id} in ${orphanSessionId.slice(0, 8)}...)${RESET}: ${task.subject}`
      )
      adopted++
    }
  }

  const skippedNote = skipped > 0 ? `, ${skipped} skipped (duplicate subject)` : ""
  console.log(
    `\n  ${adopted} task(s) adopted into session ${targetSessionId.slice(0, 8)}...${skippedNote}\n`
  )
}

// ─── State update ─────────────────────────────────────────────────────────────

export async function applyStateUpdate(targetState: string, cwd: string): Promise<void> {
  if (!PROJECT_STATES.includes(targetState as ProjectState)) {
    throw new Error(`Invalid state: "${targetState}"\nValid states: ${PROJECT_STATES.join(", ")}`)
  }
  const state = targetState as ProjectState
  const current = await readProjectState(cwd)
  if (current) {
    const allowed = STATE_TRANSITIONS[current]
    if (!allowed.includes(state) && current !== state) {
      throw new Error(
        `Invalid transition: ${current} → ${state}\nAllowed from ${current}: ${allowed.join(", ")}`
      )
    }
  }
  await writeProjectState(cwd, state)
  const from = current && current !== state ? `${current} → ` : ""
  console.log(`  project state: ${from}${state}`)
}

// ─── Evidence submission ──────────────────────────────────────────────────────

export async function submitEvidence(
  sessionId: string,
  taskId: string,
  evidence: string,
  filterCwd?: string
) {
  const { sessionId: effectiveSessionId, task } = await resolveTaskById(
    taskId,
    sessionId,
    filterCwd
  )

  const validationError = validateEvidence(evidence)
  if (validationError) {
    throw new Error(validationError)
  }

  const ciError = await verifyCiGreenEvidence(evidence, process.cwd())
  if (ciError) throw new Error(ciError)

  task.completionEvidence = evidence
  if (!task.completionTimestamp) {
    task.completionTimestamp = new Date().toISOString()
  }
  if (task.completedAt === undefined || task.completedAt === null) {
    task.completedAt = Date.now()
  }

  await writeTask(effectiveSessionId, task, process.cwd())
  await writeAudit(effectiveSessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "status_change",
    oldStatus: task.status,
    newStatus: task.status,
    evidence,
    subject: task.subject,
  })

  console.log(`\n  ${STATUS_STYLE[task.status].emoji} #${taskId}: evidence submitted`)
  console.log(`     ${task.subject}`)
  console.log(`     ${DIM}Evidence: ${evidence}${RESET}\n`)
}

// ─── Task field update ────────────────────────────────────────────────────────

export async function writeTaskUpdate(
  sessionId: string,
  taskId: string,
  task: Task,
  newStatus?: Task["status"]
): Promise<void> {
  if (newStatus) {
    const oldStatus = task.status
    const nowIso = new Date().toISOString()
    applyStatusTransition(task, newStatus, nowIso, Date.now())
    await writeTask(sessionId, task, process.cwd())
    await writeAudit(sessionId, {
      timestamp: new Date().toISOString(),
      taskId,
      action: "status_change",
      oldStatus,
      newStatus,
      subject: task.subject,
    })
    const { emoji, color } = STATUS_STYLE[newStatus]
    console.log(`\n  ${emoji} #${taskId}: ${oldStatus} → ${color}${newStatus}${RESET}`)
    console.log(`     ${task.subject}`)
    return
  }

  await writeTask(sessionId, task, process.cwd())
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "status_change",
    oldStatus: task.status,
    newStatus: task.status,
    subject: task.subject,
  })
  console.log(`\n  ✏️  #${taskId}: updated`)
  console.log(`     ${task.subject}`)
}
