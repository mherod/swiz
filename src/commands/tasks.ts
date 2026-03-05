import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

const HOME = process.env.HOME ?? "~"
const TASKS_DIR = join(HOME, ".claude", "tasks")
const PROJECTS_DIR = join(HOME, ".claude", "projects")

// ─── Types ──────────────────────────────────────────────────────────────────

interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  blocks: string[]
  blockedBy: string[]
  completionEvidence?: string
  completionTimestamp?: string
  /** ISO timestamp of last status change (used for elapsed-time tracking) */
  statusChangedAt?: string
  /** Cumulative milliseconds spent in in_progress status */
  elapsedMs?: number
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

interface AuditEntry {
  timestamp: string
  taskId: string
  action: "create" | "status_change" | "delete"
  oldStatus?: Task["status"]
  newStatus?: Task["status"]
  verificationText?: string
  evidence?: string
  subject?: string
}

// ─── ANSI ───────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

const STATUS_STYLE: Record<Task["status"], { emoji: string; color: string }> = {
  pending: { emoji: "⏳", color: "\x1b[33m" },
  in_progress: { emoji: "🔄", color: "\x1b[36m" },
  completed: { emoji: "✅", color: "\x1b[32m" },
  cancelled: { emoji: "❌", color: "\x1b[31m" },
}

type DateFormat = "relative" | "absolute"

function formatDate(date: Date, format: DateFormat): string {
  if (format === "absolute") {
    return date.toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }
  return timeAgo(date)
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(ms / 3600000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(ms / 86400000)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`
}

// ─── Session-scoped task IDs ─────────────────────────────────────────────────

/**
 * Derive a short prefix from a session UUID for namespaced task IDs.
 * Uses the first 4 hex characters of the session ID (e.g., "a3f2").
 */
export function sessionPrefix(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 4).toLowerCase()
}

/**
 * Parse a potentially prefixed task ID into its components.
 * - "a3f2-5" → { prefix: "a3f2", seq: 5 }
 * - "5" → { prefix: null, seq: 5 }
 * - "a3f2-abc" → { prefix: "a3f2", seq: NaN } (invalid)
 */
export function parseTaskId(taskId: string): { prefix: string | null; seq: number } {
  const dashIdx = taskId.indexOf("-")
  if (dashIdx > 0) {
    const prefix = taskId.slice(0, dashIdx)
    const seq = parseInt(taskId.slice(dashIdx + 1), 10)
    return { prefix, seq }
  }
  return { prefix: null, seq: parseInt(taskId, 10) }
}

/**
 * Sort comparator for task IDs that handles both numeric and prefixed formats.
 * Prefixed IDs sort after numeric IDs; within the same prefix, sort by sequence.
 */
export function compareTaskIds(a: string, b: string): number {
  const pa = parseTaskId(a)
  const pb = parseTaskId(b)
  // Both numeric — sort numerically
  if (pa.prefix === null && pb.prefix === null) return pa.seq - pb.seq
  // Numeric before prefixed
  if (pa.prefix === null) return -1
  if (pb.prefix === null) return 1
  // Both prefixed — sort by prefix then sequence
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix)
  return pa.seq - pb.seq
}

// ─── Session discovery ──────────────────────────────────────────────────────

/** Derive session IDs from a single project transcript directory (constant-time lookup). */
export async function getSessionIdsForProject(
  projectKey: string,
  projectsDir = PROJECTS_DIR
): Promise<Set<string>> {
  const projectDir = join(projectsDir, projectKey)
  const ids = new Set<string>()
  try {
    const files = await readdir(projectDir)
    for (const f of files) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6))
    }
  } catch {}
  return ids
}

/** Slow fallback: scan all project transcript directories for sessions whose cwd matches. */
export async function getSessionIdsByCwdScan(
  filterCwd: string,
  candidates: string[],
  projectsDir = PROJECTS_DIR
): Promise<Set<string>> {
  const ids = new Set<string>()
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return ids
  }

  const candidateSet = new Set(candidates)
  for (const dir of dirs) {
    const projectDir = join(projectsDir, dir)
    let files: string[]
    try {
      files = await readdir(projectDir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue
      const sessionId = f.slice(0, -6)
      if (!candidateSet.has(sessionId)) continue
      if (ids.has(sessionId)) continue
      try {
        const content = await readFile(join(projectDir, f), "utf-8")
        for (const line of content.split("\n").slice(0, 10)) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.cwd === filterCwd) {
              ids.add(sessionId)
              break
            }
          } catch {}
        }
      } catch {}
    }
  }
  return ids
}

export async function getSessions(
  filterCwd?: string,
  tasksDir = TASKS_DIR,
  projectsDir = PROJECTS_DIR
): Promise<string[]> {
  try {
    const entries = await readdir(tasksDir)

    let matchedSessionIds: Set<string> | null = null

    if (filterCwd) {
      // Fast path: derive project key directly and intersect with task sessions.
      const projectSessionIds = await getSessionIdsForProject(
        projectKeyFromCwd(filterCwd),
        projectsDir
      )
      matchedSessionIds = new Set<string>()
      for (const s of entries) {
        if (projectSessionIds.has(s)) matchedSessionIds.add(s)
      }

      // Fallback: scan transcript cwd values for any task entries NOT already
      // matched by the fast path. This catches sessions under older or
      // mismatched project-key encodings, even when the fast path found some.
      const unmatched = entries.filter((s) => !matchedSessionIds!.has(s))
      if (unmatched.length > 0) {
        const fallbackIds = await getSessionIdsByCwdScan(filterCwd, unmatched, projectsDir)
        for (const id of fallbackIds) matchedSessionIds.add(id)
      }
    }

    const stats = await Promise.all(
      entries
        .filter((s) => !matchedSessionIds || matchedSessionIds.has(s))
        .map(async (s) => {
          const p = join(tasksDir, s)
          const st = await stat(p)
          return { session: s, mtime: st.mtime }
        })
    )
    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    return stats.map((s) => s.session)
  } catch {
    return []
  }
}

// ─── Task I/O ───────────────────────────────────────────────────────────────

async function readTasks(sessionId: string, tasksDir = TASKS_DIR): Promise<Task[]> {
  const dir = join(tasksDir, sessionId)
  try {
    const files = await readdir(dir)
    const taskFiles = files.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".") && f !== "compact-snapshot.json"
    )
    const tasks = await Promise.all(
      taskFiles.map(async (f) => {
        const filePath = join(dir, f)
        const task = JSON.parse(await readFile(filePath, "utf-8")) as Task
        // Backfill statusChangedAt from file mtime for legacy tasks
        if (!task.statusChangedAt) {
          const st = await stat(filePath)
          task.statusChangedAt = st.mtime.toISOString()
        }
        return task
      })
    )
    return tasks.sort((a, b) => compareTaskIds(a.id, b.id))
  } catch {
    return []
  }
}

async function writeTask(sessionId: string, task: Task) {
  const dir = join(TASKS_DIR, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2))
}

async function writeAudit(sessionId: string, entry: AuditEntry) {
  try {
    const dir = join(TASKS_DIR, sessionId)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, ".audit-log.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {}
}

// ─── Cross-session task lookup ───────────────────────────────────────────────

/**
 * Search for a task by ID across all sessions for the current project.
 * Returns all matches (session + task pairs). Callers must handle the
 * case where multiple sessions contain the same task ID.
 */
export async function findTaskAcrossSessions(
  taskId: string,
  filterCwd?: string,
  tasksDir = TASKS_DIR,
  projectsDir = PROJECTS_DIR
): Promise<{ sessionId: string; task: Task }[]> {
  const sessions = await getSessions(filterCwd, tasksDir, projectsDir)
  const matches: { sessionId: string; task: Task }[] = []
  for (const sessionId of sessions) {
    const tasks = await readTasks(sessionId, tasksDir)
    const task = tasks.find((t) => t.id === taskId)
    if (task) matches.push({ sessionId, task })
  }
  return matches
}

/**
 * Centralized task-by-ID resolution. Checks the primary session first,
 * then falls back to scanning all project sessions. Every command that
 * operates on a task by ID must use this single entry point.
 */
export async function resolveTaskById(
  taskId: string,
  primarySessionId: string,
  filterCwd?: string,
  tasksDir = TASKS_DIR,
  projectsDir = PROJECTS_DIR
): Promise<{ sessionId: string; task: Task }> {
  // Prefix-based fast resolution: if the ID has a session prefix, find the
  // matching session directly — no ambiguity possible.
  const { prefix } = parseTaskId(taskId)
  if (prefix !== null) {
    // First check if the primary session itself matches the prefix
    if (sessionPrefix(primarySessionId) === prefix) {
      const tasks = await readTasks(primarySessionId, tasksDir)
      const task = tasks.find((t) => t.id === taskId)
      if (task) return { sessionId: primarySessionId, task }
    }

    // Since prefix is designed to be globally unique (first 4 hex chars of UUID),
    // search all task sessions, ignoring filterCwd (which fails for Gemini CLI
    // sessions that lack .claude/projects/ transcripts).
    const sessions = await getSessions(undefined, tasksDir, projectsDir)
    const matchingSession = sessions.find((s) => sessionPrefix(s) === prefix)
    if (matchingSession) {
      const tasks = await readTasks(matchingSession, tasksDir)
      const task = tasks.find((t) => t.id === taskId)
      if (task) {
        if (matchingSession !== primarySessionId) {
          debugLog(
            `  ${DIM}Task #${taskId} resolved via prefix to session ${matchingSession.slice(0, 8)}...${RESET}`
          )
        }
        return { sessionId: matchingSession, task }
      }
    }
    throw new Error(
      `Task #${taskId} not found (prefix "${prefix}" matched no session with that task).`
    )
  }

  // Unprefixed numeric ID — check primary session first
  const tasks = await readTasks(primarySessionId, tasksDir)
  const task = tasks.find((t) => t.id === taskId)
  if (task) return { sessionId: primarySessionId, task }

  // Fallback: search across all project sessions
  const matches = await findTaskAcrossSessions(taskId, filterCwd, tasksDir, projectsDir)

  if (matches.length === 1) {
    debugLog(
      `  ${DIM}Task #${taskId} found in session ${matches[0]!.sessionId.slice(0, 8)}... (not current session)${RESET}`
    )
    return matches[0]!
  }

  if (matches.length > 1) {
    const sessionList = matches
      .map((m) => `  - ${m.sessionId.slice(0, 8)}... [${m.task.status}]: ${m.task.subject}`)
      .join("\n")
    throw new Error(
      `Task #${taskId} exists in ${matches.length} sessions. Use --session <id> to disambiguate:\n${sessionList}`
    )
  }

  throw new Error(`Task #${taskId} not found in any session for this project.`)
}

/**
 * Collect all incomplete tasks across all project sessions.
 * Used by complete-all to find tasks that may have been orphaned
 * in other session directories after compaction.
 */
async function collectIncompleteTasks(
  filterCwd?: string
): Promise<{ sessionId: string; task: Task }[]> {
  const sessions = await getSessions(filterCwd)
  const results: { sessionId: string; task: Task }[] = []
  for (const sessionId of sessions) {
    const tasks = await readTasks(sessionId)
    for (const task of tasks) {
      if (task.status === "pending" || task.status === "in_progress") {
        results.push({ sessionId, task })
      }
    }
  }
  return results
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Render a single task to stdout. `sessionTag` is an optional `[shortId]` prefix for cross-session views. */
function renderTask(task: Task, sessionTag?: string, dateFormat: DateFormat = "relative") {
  const { emoji, color } = STATUS_STYLE[task.status]
  const tag = sessionTag ? `${DIM}[${sessionTag}]${RESET} ` : ""
  console.log(
    `  ${emoji} ${BOLD}#${task.id}${RESET} ${tag}${color}[${task.status.replace("_", " ").toUpperCase()}]${RESET} ${task.subject}`
  )
  if (task.description) {
    const lines = task.description.split("\n").slice(0, 3)
    for (const line of lines) console.log(`     ${DIM}${line}${RESET}`)
    if (task.description.split("\n").length > 3) console.log(`     ${DIM}...${RESET}`)
  }
  // Show date — statusChangedAt is always present (backfilled from file mtime)
  if (task.statusChangedAt) {
    console.log(`     ${DIM}📅 ${formatDate(new Date(task.statusChangedAt), dateFormat)}${RESET}`)
  }
  // Show elapsed time for in_progress (live) and completed tasks
  if (task.status === "in_progress" && task.statusChangedAt) {
    const live = (task.elapsedMs ?? 0) + (Date.now() - new Date(task.statusChangedAt).getTime())
    console.log(`     ${DIM}⏱  ${formatElapsed(Math.max(0, live))} elapsed${RESET}`)
  } else if ((task.elapsedMs ?? 0) > 0) {
    console.log(`     ${DIM}⏱  ${formatElapsed(task.elapsedMs!)} elapsed${RESET}`)
  }
  if (task.completionEvidence)
    console.log(`     ${DIM}✓ Evidence: ${task.completionEvidence}${RESET}`)
  if (task.completionTimestamp)
    console.log(
      `     ${DIM}✓ Completed: ${formatDate(new Date(task.completionTimestamp), dateFormat)}${RESET}`
    )
  if (task.blockedBy.length)
    console.log(`     ${DIM}Blocked by: #${task.blockedBy.join(", #")}${RESET}`)
  if (task.blocks.length) console.log(`     ${DIM}Blocks: #${task.blocks.join(", #")}${RESET}`)
  console.log()
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function listTasks(sessionId: string, label: string, dateFormat: DateFormat = "relative") {
  const tasks = await readTasks(sessionId)
  console.log(`\n  ${BOLD}Tasks${RESET} ${DIM}(${label}: ${sessionId.slice(0, 8)}...)${RESET}\n`)

  if (tasks.length === 0) {
    console.log("  No tasks found.\n")
    return
  }

  const groups: [string, Task[]][] = [
    ["IN PROGRESS", tasks.filter((t) => t.status === "in_progress")],
    ["PENDING", tasks.filter((t) => t.status === "pending")],
    ["COMPLETED", tasks.filter((t) => t.status === "completed")],
    ["CANCELLED", tasks.filter((t) => t.status === "cancelled")],
  ]

  for (const [title, group] of groups) {
    if (group.length === 0) continue
    console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`)
    for (const task of group) renderTask(task, undefined, dateFormat)
  }

  const incomplete = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length
  const completed = tasks.filter((t) => t.status === "completed").length
  console.log(
    `  ${BOLD}Summary:${RESET} ${incomplete}/${tasks.length} incomplete, ${completed} completed\n`
  )
}

async function listAllSessionsTasks(filterCwd?: string, dateFormat: DateFormat = "relative") {
  const sessions = await getSessions(filterCwd)
  const label = filterCwd ? "current project" : "all projects"

  if (sessions.length === 0) {
    console.log(`\n  ${BOLD}Tasks${RESET} ${DIM}(${label}, all sessions)${RESET}\n`)
    console.log("  No sessions found.\n")
    return
  }

  let totalTasks = 0
  let totalIncomplete = 0
  let totalCompleted = 0
  let sessionsWithTasks = 0

  for (const sessionId of sessions) {
    const tasks = await readTasks(sessionId)
    if (tasks.length === 0) continue

    sessionsWithTasks++
    totalTasks += tasks.length

    const shortId = sessionId.slice(0, 8)
    console.log(`\n  ${BOLD}Session${RESET} ${DIM}${shortId}...${RESET}\n`)

    const groups: [string, Task[]][] = [
      ["IN PROGRESS", tasks.filter((t) => t.status === "in_progress")],
      ["PENDING", tasks.filter((t) => t.status === "pending")],
      ["COMPLETED", tasks.filter((t) => t.status === "completed")],
      ["CANCELLED", tasks.filter((t) => t.status === "cancelled")],
    ]

    for (const [title, group] of groups) {
      if (group.length === 0) continue
      console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`)
      for (const task of group) renderTask(task, shortId, dateFormat)
    }

    const incomplete = tasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress"
    ).length
    const completed = tasks.filter((t) => t.status === "completed").length
    totalIncomplete += incomplete
    totalCompleted += completed
    console.log(
      `  ${DIM}${incomplete}/${tasks.length} incomplete, ${completed} completed${RESET}\n`
    )
  }

  console.log(
    `\n  ${BOLD}All sessions summary:${RESET} ${sessionsWithTasks} session(s), ` +
      `${totalIncomplete}/${totalTasks} incomplete, ${totalCompleted} completed\n`
  )
}

async function createTask(sessionId: string, subject: string, description: string) {
  const tasks = await readTasks(sessionId)
  const prefix = sessionPrefix(sessionId)
  // Find max sequence number among this session's prefixed IDs
  const maxSeq = tasks.reduce((m, t) => {
    const parsed = parseTaskId(t.id)
    // Count both unprefixed (legacy) and same-prefix IDs for safe sequencing
    const seq = parsed.prefix === prefix || parsed.prefix === null ? parsed.seq : 0
    return Math.max(m, Number.isNaN(seq) ? 0 : seq)
  }, 0)
  const id = `${prefix}-${maxSeq + 1}`

  const task: Task = {
    id,
    subject,
    description,
    status: "pending",
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    subjectFingerprint: computeSubjectFingerprint(subject),
    blocks: [],
    blockedBy: [],
  }

  await writeTask(sessionId, task)
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

async function updateStatus(
  sessionId: string,
  taskId: string,
  newStatus: Task["status"],
  evidence?: string,
  verifyText?: string,
  filterCwd?: string
) {
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

  if (evidence) {
    const validationError = validateEvidence(evidence)
    if (validationError) throw new Error(validationError)
  }

  const oldStatus = task.status
  const now = new Date().toISOString()

  // Accumulate elapsed time when leaving in_progress
  if (oldStatus === "in_progress" && task.statusChangedAt) {
    const elapsed = Date.now() - new Date(task.statusChangedAt).getTime()
    task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, elapsed)
  }

  task.status = newStatus
  task.statusChangedAt = now
  if (newStatus === "completed" && evidence) {
    task.completionEvidence = evidence
    task.completionTimestamp = now
  }

  await writeTask(effectiveSessionId, task)
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

async function completeAll(filterCwd?: string, evidence?: string) {
  const resolvedEvidence = evidence ?? "note:bulk-complete"
  const evidenceError = validateEvidence(resolvedEvidence)
  if (evidenceError) throw new Error(evidenceError)

  const incomplete = await collectIncompleteTasks(filterCwd)

  if (incomplete.length === 0) {
    console.log("\n  No incomplete tasks.\n")
    return
  }

  console.log(
    `\n  Completing ${incomplete.length} task(s) across ${new Set(incomplete.map((i) => i.sessionId)).size} session(s)...\n`
  )
  for (const { sessionId, task } of incomplete) {
    await updateStatus(sessionId, task.id, "completed", resolvedEvidence, undefined, filterCwd)
  }
}

// ─── Verification & Evidence ─────────────────────────────────────────────────

const EVIDENCE_PREFIXES = ["commit:", "pr:", "file:", "test:", "note:"]

export function validateEvidence(evidence: string): string | null {
  if (EVIDENCE_PREFIXES.some((p) => evidence.startsWith(p))) return null
  return (
    `Invalid evidence format: "${evidence}"\n` +
    "Evidence must start with a recognized prefix:\n" +
    EVIDENCE_PREFIXES.map((p) => `  ${p}<value>`).join("\n") +
    '\n\nExample: --evidence "commit:abc123f" or --evidence "note:CI green"'
  )
}

export function verifyTaskSubject(taskSubject: string, verifyText: string): string | null {
  const normalizedSubject = taskSubject.toLowerCase().trim()
  const normalizedVerify = verifyText.toLowerCase().trim()
  if (normalizedSubject.startsWith(normalizedVerify)) return null
  return (
    `Verification failed.\n` +
    `  Expected subject to start with: "${verifyText}"\n` +
    `  Actual subject: "${taskSubject}"`
  )
}

async function submitEvidence(
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

  task.completionEvidence = evidence
  if (!task.completionTimestamp) {
    task.completionTimestamp = new Date().toISOString()
  }

  await writeTask(effectiveSessionId, task)
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

// ─── Arg parsing ────────────────────────────────────────────────────────────

function parseDateFormat(value: string | undefined): DateFormat {
  if (!value) return "relative"
  if (value === "relative" || value === "absolute") return value
  throw new Error(`Invalid --date-format value: "${value}". Must be "relative" or "absolute".`)
}

function extractFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

async function resolveSession(args: string[]): Promise<string> {
  const explicit = extractFlag(args, "--session")

  if (explicit) {
    // If a session is explicitly requested, search all sessions regardless of cwd.
    // This allows addressing tasks for non-Claude agents (e.g. Gemini) that don't
    // generate .claude/projects/ transcripts.
    const allSessions = await getSessions()
    const match = allSessions.find((s) => s.startsWith(explicit))
    if (!match) {
      throw new Error(`Session "${explicit}" not found.`)
    }
    return match
  }

  const allProjects = args.includes("--all-projects")
  const filterCwd = allProjects ? undefined : process.cwd()
  const sessions = await getSessions(filterCwd)

  if (sessions.length === 0) {
    if (filterCwd) {
      throw new Error(`No task sessions found for ${filterCwd}.\nUse --all-projects to see all.`)
    } else {
      throw new Error("No task sessions found.")
    }
  }

  return sessions[0]!
}

// ─── Command ────────────────────────────────────────────────────────────────

export const tasksCommand: Command = {
  name: "tasks",
  description: "View and manage agent tasks",
  usage:
    "swiz tasks [create|complete|evidence|status|complete-all] [--session <id>] [--all-projects] [--all-sessions] [--date-format <relative|absolute>] [--evidence <text>] [--verify <text>]",
  options: [
    { flags: "create <subject> <desc>", description: "Create a new task in the current session" },
    {
      flags: "complete <id>",
      description: "Mark a task completed (requires --evidence)",
    },
    {
      flags: "evidence <id> <text>",
      description: "Submit evidence to a task (commit:, pr:, file:, test:, note:)",
    },
    {
      flags: "status <id> <status>",
      description: "Set status: pending | in_progress | completed | cancelled",
    },
    { flags: "complete-all", description: "Mark all incomplete tasks in the session completed" },
    { flags: "--session <id>", description: "Target a specific session (prefix match)" },
    { flags: "--all-projects", description: "Show tasks from all projects, not just cwd" },
    {
      flags: "--all-sessions",
      description: "Show tasks from all sessions (not just the most recent)",
    },
    {
      flags: "--date-format <relative|absolute>",
      description: "Date display format (default: relative)",
    },
    {
      flags: "--evidence <text>",
      description: "Completion evidence (commit:, pr:, file:, test:, note:)",
    },
    {
      flags: "--verify <text>",
      description: "Verify task subject starts with this text (safety check)",
    },
  ],
  async run(args) {
    const subcommand = args[0]

    if (
      !subcommand ||
      subcommand === "--session" ||
      subcommand === "--all-projects" ||
      subcommand === "--all-sessions" ||
      subcommand === "--date-format"
    ) {
      const allProjects = args.includes("--all-projects")
      const allSessions = args.includes("--all-sessions")
      const filterCwd = allProjects ? undefined : process.cwd()
      const dateFormat = parseDateFormat(extractFlag(args, "--date-format"))

      if (allSessions) {
        await listAllSessionsTasks(filterCwd, dateFormat)
        return
      }

      const sessionId = await resolveSession(args)
      await listTasks(sessionId, allProjects ? "all projects" : "current project", dateFormat)

      if (!args.includes("--session") && !allProjects) {
        const tasks = await readTasks(sessionId)
        const hasIncomplete = tasks.some(
          (t) => t.status === "pending" || t.status === "in_progress"
        )
        if (!hasIncomplete && tasks.length > 0) {
          const filterCwd = process.cwd()
          const sessions = await getSessions(filterCwd)
          for (let i = 1; i < sessions.length; i++) {
            const prevSessionId = sessions[i]!
            const prev = await readTasks(prevSessionId)
            const prevIncomplete = prev.filter(
              (t) => t.status === "pending" || t.status === "in_progress"
            )
            if (prevIncomplete.length > 0) {
              console.log(
                `  ${DIM}Incomplete tasks in previous session: ${prevSessionId.slice(0, 8)}...${RESET}`
              )
              for (const t of prevIncomplete) {
                console.log(
                  `    ${DIM}swiz tasks complete ${t.id} --session ${prevSessionId} --evidence "note:done"${RESET}`
                )
              }
              console.log()
              break
            }
          }
        }
      }
      return
    }

    const rest = args.slice(1)
    const allProjects = args.includes("--all-projects")
    const filterCwd = allProjects ? undefined : process.cwd()

    switch (subcommand) {
      case "create": {
        const subject = rest[0]
        const description = rest[1]
        if (!subject || !description) {
          throw new Error('Usage: swiz tasks create "<subject>" "<description>"')
        }
        const sessionId = await resolveSession(rest.slice(2))
        await createTask(sessionId, subject, description)
        break
      }

      case "complete": {
        const taskId = rest[0]
        if (!taskId) {
          throw new Error("Usage: swiz tasks complete <task-id> --evidence TEXT [--verify TEXT]")
        }
        const evidence = extractFlag(rest, "--evidence")
        const verify = extractFlag(rest, "--verify")
        const sessionId = await resolveSession(rest.slice(1))
        await updateStatus(sessionId, taskId, "completed", evidence, verify, filterCwd)
        break
      }

      case "evidence": {
        const taskId = rest[0]
        const evidenceText = rest[1]
        if (!taskId || !evidenceText) {
          throw new Error(
            'Usage: swiz tasks evidence <task-id> "<evidence>"\n' +
              "Prefixes: commit:, pr:, file:, test:, note:"
          )
        }
        const sessionId = await resolveSession(rest.slice(2))
        await submitEvidence(sessionId, taskId, evidenceText, filterCwd)
        break
      }

      case "status": {
        const taskId = rest[0]
        const newStatus = rest[1] as Task["status"] | undefined
        const valid: Task["status"][] = ["pending", "in_progress", "completed", "cancelled"]
        if (!taskId || !newStatus || !valid.includes(newStatus)) {
          throw new Error(
            `Usage: swiz tasks status <task-id> <${valid.join("|")}> [--evidence TEXT] [--verify TEXT]`
          )
        }
        const evidence = extractFlag(rest, "--evidence")
        const verify = extractFlag(rest, "--verify")
        const sessionId = await resolveSession(rest.slice(2))
        await updateStatus(sessionId, taskId, newStatus, evidence, verify, filterCwd)
        break
      }

      case "complete-all": {
        const evidence = extractFlag(rest, "--evidence")
        await completeAll(filterCwd, evidence ?? undefined)
        break
      }

      default:
        throw new Error(`Unknown subcommand: ${subcommand}\nRun "swiz help tasks" for usage.`)
    }
  },
}
