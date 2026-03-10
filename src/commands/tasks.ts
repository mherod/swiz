import { DIM, RESET } from "../ansi.ts"
import {
  PROJECT_STATES,
  type ProjectState,
  readProjectState,
  STATE_TRANSITIONS,
  writeProjectState,
} from "../settings.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { type DateFormat, listAllSessionsTasks, listTasks } from "../tasks/task-renderer.ts"
import {
  compareTaskIds,
  parseTaskId,
  readTasks,
  STATUS_STYLE,
  sessionPrefix,
  type Task,
  writeAudit,
  writeTask,
} from "../tasks/task-repository.ts"
import {
  collectIncompleteTasks,
  findTaskAcrossSessions,
  getOrphanSessionIds,
  getSessionIdsByCwdScan,
  getSessionIdsForProject,
  getSessions,
  resolveTaskById,
} from "../tasks/task-resolver.ts"
import type { Command } from "../types.ts"

export {
  compareTaskIds,
  findTaskAcrossSessions,
  getOrphanSessionIds,
  getSessionIdsByCwdScan,
  getSessionIdsForProject,
  getSessions,
  parseTaskId,
  resolveTaskById,
  sessionPrefix,
}

// ─── Validation & evidence ───────────────────────────────────────────────────

const EVIDENCE_PREFIXES = ["commit:", "pr:", "file:", "test:", "note:"]

/**
 * Segment-anchored evidence patterns.
 * Evidence is split on delimiters (—, --, ;, |, ", ") into segments first,
 * then each pattern is matched against the START of each segment.
 * This prevents free-text within one field's value (e.g. "note:CI green")
 * from satisfying the ci_green pattern as a second distinct field.
 */
const EVIDENCE_SEGMENT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "note", re: /^note\s*:\s*\S.{4,}/i },
  { name: "conclusion", re: /^conclusion\s*:\s*\S+/i },
  { name: "run", re: /^run\s+\d{3,}/i },
  { name: "commit", re: /^(?:commit\s*:\s*)?[0-9a-f]{7,40}$/i },
  { name: "ci_green", re: /^ci[\s_]green$/i },
  { name: "pr", re: /^pr[:#]\s*\d+/i },
  { name: "no_ci", re: /^no[\s_]ci\b.*(workflow|run|configured)/i },
]

const REQUIRED_EVIDENCE_FIELDS = 1

/** Split evidence on delimiters, check each segment independently, return matched field names. */
function countEvidenceFields(evidence: string): string[] {
  const segments = evidence
    .split(/\s*(?:—|--|;|\|)\s*|\s*,\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const foundKeys = new Set<string>()
  for (const segment of segments) {
    for (const { name, re } of EVIDENCE_SEGMENT_PATTERNS) {
      if (re.test(segment)) {
        foundKeys.add(name)
        break
      }
    }
  }
  return [...foundKeys]
}

export function validateEvidence(evidence: string): string | null {
  if (!EVIDENCE_PREFIXES.some((p) => evidence.startsWith(p))) {
    return (
      `Invalid evidence format: "${evidence}"\n` +
      "Evidence must start with a recognized prefix:\n" +
      EVIDENCE_PREFIXES.map((p) => `  ${p}<value>`).join("\n") +
      '\n\nExample: --evidence "commit:abc123f" or --evidence "note:CI green"'
    )
  }

  const matched = countEvidenceFields(evidence)
  if (matched.length < REQUIRED_EVIDENCE_FIELDS) {
    const found = matched.length > 0 ? matched.join(", ") : "none"
    return (
      `Evidence must contain at least ${REQUIRED_EVIDENCE_FIELDS} structured field, but found ${matched.length} (${found}).\n\n` +
      `Structured fields (any ${REQUIRED_EVIDENCE_FIELDS}+ required):\n` +
      EVIDENCE_SEGMENT_PATTERNS.map(({ name }) => `  • ${name}`).join("\n") +
      '\n\nExample: --evidence "note:CI green"'
    )
  }

  return null
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

// ─── Actions ─────────────────────────────────────────────────────────────────

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

async function completeAll(filterCwd?: string, evidence?: string) {
  const resolvedEvidence = evidence ?? "note:bulk-complete — conclusion: all tasks completed"
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

// ─── State update ─────────────────────────────────────────────────────────────

async function applyStateUpdate(targetState: string, cwd: string): Promise<void> {
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

// ─── Arg parsing ──────────────────────────────────────────────────────────────

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
  let sessions = await getSessions(filterCwd)

  // Compaction fallback: if no sessions found for cwd (e.g. new post-compaction
  // session whose transcript hasn't been indexed yet), fall back to the most
  // recently modified session across all projects. This handles the gap where
  // Claude Code creates a task directory before the transcript is written.
  if (sessions.length === 0 && filterCwd) {
    sessions = await getSessions(undefined)
  }

  if (sessions.length === 0) {
    if (filterCwd) {
      throw new Error(`No task sessions found for ${filterCwd}.\nUse --all-projects to see all.`)
    } else {
      throw new Error("No task sessions found.")
    }
  }

  return sessions[0]!
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const tasksCommand: Command = {
  name: "tasks",
  description: "View and manage agent tasks",
  usage:
    "swiz tasks [create|complete|evidence|status|complete-all] [--session <id>] [--all-projects] [--all-sessions] [--recovered] [--date-format <relative|absolute>] [--evidence <text>] [--verify <text>] [--state <state>]",
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
      flags: "--recovered",
      description: "Show only tasks from orphan (compaction-gap) sessions",
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
    {
      flags: "--state <state>",
      description: `Also update project state (${PROJECT_STATES.join("|")})`,
    },
  ],
  async run(args) {
    const [subcommand] = args

    if (
      !subcommand ||
      subcommand === "--session" ||
      subcommand === "--all-projects" ||
      subcommand === "--all-sessions" ||
      subcommand === "--recovered" ||
      subcommand === "--date-format"
    ) {
      const allProjects = args.includes("--all-projects")
      const allSessions = args.includes("--all-sessions")
      const recovered = args.includes("--recovered")
      const filterCwd = allProjects ? undefined : process.cwd()
      const dateFormat = parseDateFormat(extractFlag(args, "--date-format"))

      if (allSessions || recovered) {
        await listAllSessionsTasks(filterCwd, dateFormat, recovered)
        return
      }

      const sessionId = await resolveSession(args)
      const orphanIds = await getOrphanSessionIds()
      await listTasks(
        sessionId,
        allProjects ? "all projects" : "current project",
        dateFormat,
        orphanIds.has(sessionId)
      )

      if (!args.includes("--session") && !allProjects) {
        const tasks = await readTasks(sessionId)
        const hasIncomplete = tasks.some(
          (t) => t.status === "pending" || t.status === "in_progress"
        )
        if (!hasIncomplete && tasks.length > 0) {
          const cwdFilter = process.cwd()
          const sessions = await getSessions(cwdFilter)
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
        const [subject, description, ...sessionArgs] = rest
        if (!subject || !description) {
          throw new Error('Usage: swiz tasks create "<subject>" "<description>" --state <state>')
        }
        const stateFlag = extractFlag(rest, "--state")
        if (!stateFlag) {
          throw new Error(
            `--state <state> is required.\n` +
              `It sets the session's active working phase (not the task's todo status).\n` +
              `Valid phases: ${PROJECT_STATES.join(" | ")}\n` +
              `Example: swiz tasks create "<subject>" "<description>" --state developing`
          )
        }
        const sessionId = await resolveSession(sessionArgs)
        await createTask(sessionId, subject, description)
        await applyStateUpdate(stateFlag, process.cwd())
        break
      }

      case "complete": {
        const [taskId, ...sessionArgs] = rest
        if (!taskId) {
          throw new Error(
            "Usage: swiz tasks complete <task-id> --evidence TEXT --state <state> [--verify TEXT]"
          )
        }
        const evidence = extractFlag(rest, "--evidence")
        const stateFlag = extractFlag(rest, "--state")
        if (!stateFlag) {
          throw new Error(
            `--state <state> is required.\n` +
              `It sets the session's active working phase (not the task's todo status).\n` +
              `Valid phases: ${PROJECT_STATES.join(" | ")}\n` +
              `Example: swiz tasks complete ${taskId} --evidence "note:done" --state developing`
          )
        }
        let verify = extractFlag(rest, "--verify")
        const sessionId = await resolveSession(sessionArgs)

        // Auto-verify: if no explicit --verify was provided, extract and use task subject
        if (!verify) {
          const { task } = await resolveTaskById(taskId, sessionId, filterCwd)
          verify = task.subject
        }

        await updateStatus(sessionId, taskId, "completed", evidence, verify, filterCwd)
        await applyStateUpdate(stateFlag, process.cwd())
        break
      }

      case "evidence": {
        const [taskId, evidenceText, ...sessionArgs] = rest
        if (!taskId || !evidenceText) {
          throw new Error(
            'Usage: swiz tasks evidence <task-id> "<evidence>"\n' +
              "Prefixes: commit:, pr:, file:, test:, note:"
          )
        }
        const sessionId = await resolveSession(sessionArgs)
        await submitEvidence(sessionId, taskId, evidenceText, filterCwd)
        break
      }

      case "status": {
        const [taskId, nextStatus, ...sessionArgs] = rest
        const newStatus = nextStatus as Task["status"] | undefined
        const valid: Task["status"][] = ["pending", "in_progress", "completed", "cancelled"]
        if (!taskId || !newStatus || !valid.includes(newStatus)) {
          throw new Error(
            `Usage: swiz tasks status <task-id> <${valid.join("|")}> --state <state> [--evidence TEXT] [--verify TEXT]`
          )
        }
        const evidence = extractFlag(rest, "--evidence")
        const verify = extractFlag(rest, "--verify")
        const stateFlag = extractFlag(rest, "--state")
        if (!stateFlag) {
          throw new Error(
            `--state <state> is required.\n` +
              `It sets the session's active working phase (not the task's todo status).\n` +
              `Valid phases: ${PROJECT_STATES.join(" | ")}\n` +
              `Example: swiz tasks status ${taskId} ${newStatus} --state developing`
          )
        }
        const sessionId = await resolveSession(sessionArgs)
        await updateStatus(sessionId, taskId, newStatus, evidence, verify, filterCwd)
        await applyStateUpdate(stateFlag, process.cwd())
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
