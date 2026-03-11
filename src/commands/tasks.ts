import { unlink } from "node:fs/promises"
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
import { getDefaultTaskRoots } from "../task-roots.ts"
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
  { name: "file", re: /^file\s*:\s*\S+/i },
  { name: "test", re: /^test\s*:\s*\S+/i },
  { name: "no_ci", re: /^no[\s_]ci\b.*(workflow|run|configured)/i },
]

const REQUIRED_EVIDENCE_FIELDS = 1

// Invariant: every EVIDENCE_PREFIXES entry must have a matching pattern name.
// Throws at module load time so drift is caught immediately rather than silently
// accepting a prefix that will never satisfy field validation.
{
  const _patternNames = new Set(EVIDENCE_SEGMENT_PATTERNS.map((p) => p.name))
  for (const prefix of EVIDENCE_PREFIXES) {
    const key = prefix.replace(/:$/, "")
    if (!_patternNames.has(key)) {
      throw new Error(
        `[tasks] EVIDENCE_PREFIXES mismatch: "${prefix}" has no corresponding entry in ` +
          `EVIDENCE_SEGMENT_PATTERNS. Add { name: "${key}", re: /^${key}\\s*:\\s*\\S+/i } to EVIDENCE_SEGMENT_PATTERNS.`
      )
    }
  }
}

const COMMIT_PREFIX_RE = /^commit\s*:\s*/i
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i

/** Split evidence on delimiters, check each segment independently, return matched field names. */
function countEvidenceFields(evidence: string): string[] {
  const rawSegments = evidence
    .split(/\s*(?:—|--|;|\|)\s*|\s*,\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Expand "commit:<sha1> <sha2> ..." into one "commit:<sha>" segment per SHA
  const segments: string[] = []
  for (const seg of rawSegments) {
    const prefixMatch = COMMIT_PREFIX_RE.exec(seg)
    if (prefixMatch) {
      const rest = seg.slice(prefixMatch[0].length).trim()
      const tokens = rest.split(/\s+/)
      if (tokens.length > 1 && tokens.every((t) => HEX_SHA_RE.test(t))) {
        for (const sha of tokens) segments.push(`commit:${sha}`)
        continue
      }
    }
    segments.push(seg)
  }
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

  // Validate every segment's prefix, not just the first one.
  // A segment "looks like" it has a prefix when it contains ":" and the text
  // before the first ":" is 2–20 word characters (not a URL or plain sentence).
  // A prefix-shaped segment is valid if it either starts with an EVIDENCE_PREFIXES
  // entry OR matches at least one EVIDENCE_SEGMENT_PATTERNS regex (e.g. "conclusion:").
  const SEGMENT_SPLIT_RE = /\s*(?:—|--|;|\|)\s*|\s*,\s+/
  const PREFIX_SHAPE_RE = /^(\w{2,20}):/
  const segments = evidence
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const seg of segments) {
    const m = PREFIX_SHAPE_RE.exec(seg)
    if (m) {
      const candidate = `${m[1]}:`
      const isKnownPrefix = EVIDENCE_PREFIXES.includes(candidate)
      const matchesPattern = EVIDENCE_SEGMENT_PATTERNS.some(({ re }) => re.test(seg))
      if (!isKnownPrefix && !matchesPattern) {
        return (
          `Invalid evidence prefix "${candidate}" in segment: "${seg}"\n` +
          "Recognized prefixes:\n" +
          EVIDENCE_PREFIXES.map((p) => `  ${p}<value>`).join("\n") +
          '\n\nExample: --evidence "commit:abc123f" or --evidence "note:CI green"'
        )
      }
    }
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

interface EnsureFileBackedTaskOptions {
  sessionId: string
  taskId: string
  filterCwd?: string
  subject?: string
  description?: string
  activeForm?: string
  status?: Task["status"]
  allowPlaceholderSubject?: boolean
}

async function ensureFileBackedTask({
  sessionId,
  taskId,
  filterCwd,
  subject,
  description,
  activeForm,
  status = "in_progress",
  allowPlaceholderSubject = false,
}: EnsureFileBackedTaskOptions): Promise<boolean> {
  try {
    await resolveTaskById(taskId, sessionId, filterCwd)
    return false
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not found")) {
      throw error
    }
  }

  const recoveredSubject = subject ?? (allowPlaceholderSubject ? `Task #${taskId}` : null)
  if (!recoveredSubject) return false

  const stubTask: Task = {
    id: taskId,
    subject: recoveredSubject,
    description: description ?? recoveredSubject,
    activeForm,
    status,
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    blocks: [],
    blockedBy: [],
  }
  await writeTask(sessionId, stubTask, process.cwd())
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "create",
    newStatus: stubTask.status,
    subject: recoveredSubject,
  })

  if (!subject && allowPlaceholderSubject) {
    console.log(
      `  ℹ️  Task #${taskId} not in file store — created stub (using task ID as placeholder)`
    )
  } else {
    console.log(`  ℹ️  Task #${taskId} not in file store — created stub from --subject`)
  }
  return true
}

async function updateStatus(
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

async function completeAll(targetSessionId: string, filterCwd?: string, evidence?: string) {
  const resolvedEvidence = evidence ?? "note:bulk-complete — conclusion: all tasks completed"
  const evidenceError = validateEvidence(resolvedEvidence)
  if (evidenceError) throw new Error(evidenceError)

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
    await updateStatus(targetSessionId, task.id, "completed", {
      evidence: resolvedEvidence,
      filterCwd,
    })
  }
}

// ─── Adopt ────────────────────────────────────────────────────────────────────

/**
 * Re-associate all tasks from orphan (compaction-gap) sessions into the given
 * target session. Each task is written to the target session directory under a
 * new prefixed ID to avoid collisions, then removed from the orphan session.
 * Skips orphan sessions that already belong to another project (none do by
 * definition, but guards against stale index races).
 */
async function adoptOrphanedTasks(targetSessionId: string, cwd: string): Promise<void> {
  const orphanIds = await getOrphanSessionIds()
  if (orphanIds.size === 0) {
    console.log("\n  No recovered sessions to adopt.\n")
    return
  }

  const { tasksDir } = getDefaultTaskRoots()
  const prefix = sessionPrefix(targetSessionId)

  // Determine starting sequence number and build dedup index for the target session
  const existing = await readTasks(targetSessionId)
  let maxSeq = existing.reduce((m, t) => {
    const parsed = parseTaskId(t.id)
    const seq = parsed.prefix === prefix || parsed.prefix === null ? parsed.seq : 0
    return Math.max(m, Number.isNaN(seq) ? 0 : seq)
  }, 0)

  // Dedup index: set of subject fingerprints already present in the target session
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
      // Remove from orphan session
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

async function printPreviousSessionIncompleteHint(sessionId: string): Promise<void> {
  const tasks = await readTasks(sessionId)
  if (tasks.length === 0) return

  const hasIncomplete = tasks.some((t) => t.status === "pending" || t.status === "in_progress")
  if (hasIncomplete) return

  const sessions = await getSessions(process.cwd())
  for (const prevSessionId of sessions.slice(1)) {
    const prev = await readTasks(prevSessionId)
    const prevIncomplete = prev.filter((t) => t.status === "pending" || t.status === "in_progress")
    if (prevIncomplete.length === 0) continue

    console.log(
      `  ${DIM}Incomplete tasks in previous session: ${prevSessionId.slice(0, 8)}...${RESET}`
    )
    for (const task of prevIncomplete) {
      console.log(
        `    ${DIM}swiz tasks complete ${task.id} --session ${prevSessionId} --evidence "note:done"${RESET}`
      )
    }
    console.log()
    break
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const tasksCommand: Command = {
  name: "tasks",
  description: "View and manage agent tasks",
  usage:
    "swiz tasks [create|complete|evidence|status|complete-all|adopt] [--session <id>] [--all-projects] [--all-sessions] [--recovered] [--date-format <relative|absolute>] [--evidence <text>] [--verify <text>] [--state <state>]",
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
    {
      flags: "adopt [--recovered]",
      description: "Re-associate orphan (compaction-gap) session tasks to the current session",
    },
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
        await printPreviousSessionIncompleteHint(sessionId)
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
            "Usage: swiz tasks complete <task-id> --evidence TEXT --state <state> [--verify TEXT] [--subject TEXT] [--dry-run]"
          )
        }
        const dryRun = rest.includes("--dry-run")
        const evidence = extractFlag(rest, "--evidence")
        const stateFlag = extractFlag(rest, "--state")
        const subjectFlag = extractFlag(rest, "--subject")

        // --dry-run: validate the task exists without performing any mutations.
        if (dryRun) {
          const sessionId = await resolveSession(sessionArgs)
          try {
            const { task } = await resolveTaskById(taskId, sessionId, filterCwd)
            console.log(`  ✅ #${taskId}: found — "${task.subject}" (${task.status})`)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.log(`  ❌ #${taskId}: ${msg}`)
            process.exitCode = 1
          }
          break
        }

        let verify = extractFlag(rest, "--verify")
        const sessionId = await resolveSession(sessionArgs)

        await ensureFileBackedTask({
          sessionId,
          taskId,
          filterCwd,
          subject: subjectFlag,
          allowPlaceholderSubject: true,
        })

        // Auto-verify: if no explicit --verify was provided, extract and use task subject
        if (!verify) {
          const { task } = await resolveTaskById(taskId, sessionId, filterCwd)
          verify = task.subject
        }

        await updateStatus(sessionId, taskId, "completed", {
          evidence,
          verifyText: verify,
          filterCwd,
        })
        if (stateFlag) await applyStateUpdate(stateFlag, process.cwd())
        break
      }

      case "evidence": {
        const [taskId, evidenceText, ...sessionArgs] = rest
        if (!taskId || !evidenceText) {
          throw new Error(
            'Usage: swiz tasks evidence <task-id> "<evidence>" [--subject TEXT]\n' +
              "Prefixes: commit:, pr:, file:, test:, note:"
          )
        }
        const subjectFlag = extractFlag(rest, "--subject")
        const sessionId = await resolveSession(sessionArgs)

        await ensureFileBackedTask({
          sessionId,
          taskId,
          filterCwd,
          subject: subjectFlag,
        })

        await submitEvidence(sessionId, taskId, evidenceText, filterCwd)
        break
      }

      case "status": {
        const [taskId, nextStatus, ...sessionArgs] = rest
        const newStatus = nextStatus as Task["status"] | undefined
        const valid: Task["status"][] = ["pending", "in_progress", "completed", "cancelled"]
        if (!taskId || !newStatus || !valid.includes(newStatus)) {
          throw new Error(
            `Usage: swiz tasks status <task-id> <${valid.join("|")}> --state <state> [--evidence TEXT] [--verify TEXT] [--subject TEXT]`
          )
        }
        const evidence = extractFlag(rest, "--evidence")
        const verify = extractFlag(rest, "--verify")
        const stateFlag = extractFlag(rest, "--state")
        const subjectFlag = extractFlag(rest, "--subject")
        const sessionId = await resolveSession(sessionArgs)

        await ensureFileBackedTask({
          sessionId,
          taskId,
          filterCwd,
          subject: subjectFlag,
        })

        await updateStatus(sessionId, taskId, newStatus, {
          evidence,
          verifyText: verify,
          filterCwd,
        })
        if (stateFlag) await applyStateUpdate(stateFlag, process.cwd())
        break
      }

      case "update": {
        const UPDATE_USAGE =
          "Usage: swiz tasks update <task-id>... [--subject TEXT] [--description TEXT]\n" +
          "                         [--active-form TEXT] [--status STATUS] [--state STATE]\n" +
          "                         [--session ID]\n\n" +
          "Accepts one or more space-separated task IDs; the same field changes are applied\n" +
          "to every listed task in sequence.\n\n" +
          "Mutable fields:\n" +
          "  --subject TEXT       Replace the task subject (one-line imperative title)\n" +
          "  --description TEXT   Replace the task description\n" +
          "  --active-form TEXT   Replace the in-progress spinner label\n" +
          "  --status STATUS      Change status: pending | in_progress | completed | cancelled\n" +
          "  --state STATE        Update the session working phase\n\n" +
          "At least one of --subject, --description, --active-form, or --status is required.\n" +
          'To add evidence to a completed task, use: swiz tasks evidence <task-id> "<evidence>"'

        // Split rest into task IDs (leading non-flag tokens) and flag tokens
        const firstFlagIdx = rest.findIndex((t) => t.startsWith("--"))
        const taskIds = (firstFlagIdx === -1 ? rest : rest.slice(0, firstFlagIdx)).filter(Boolean)
        const flagArgs = firstFlagIdx === -1 ? [] : rest.slice(firstFlagIdx)

        if (taskIds.length === 0 || taskIds[0] === "--help" || taskIds[0] === "-h") {
          console.log(UPDATE_USAGE)
          break
        }

        const KNOWN_UPDATE_FLAGS = new Set([
          "--subject",
          "--description",
          "--active-form",
          "--status",
          "--state",
          "--session",
        ])
        // Reject unknown --flags (flag values — the tokens after each flag — are not flag names)
        const flagNames = flagArgs.filter((t) => t.startsWith("--"))
        const unknownFlags = flagNames.filter((t) => !KNOWN_UPDATE_FLAGS.has(t))
        if (unknownFlags.length > 0) {
          throw new Error(`Unknown flag(s): ${unknownFlags.join(", ")}\n\n${UPDATE_USAGE}`)
        }

        const newSubject = extractFlag(flagArgs, "--subject")
        const newDescription = extractFlag(flagArgs, "--description")
        const newActiveForm = extractFlag(flagArgs, "--active-form")
        const newStatusRaw = extractFlag(flagArgs, "--status")
        const stateFlag = extractFlag(flagArgs, "--state")
        const newStatus = newStatusRaw as Task["status"] | undefined
        const valid: Task["status"][] = ["pending", "in_progress", "completed", "cancelled"]
        if (newStatus && !valid.includes(newStatus)) {
          throw new Error(
            `--status "${newStatusRaw}" is not valid. Must be one of: ${valid.join(" | ")}`
          )
        }
        if (!newSubject && !newDescription && !newActiveForm && !newStatus) {
          throw new Error(
            "At least one of --subject, --description, --active-form, or --status is required.\n\n" +
              UPDATE_USAGE
          )
        }
        const sessionId = await resolveSession(flagArgs)

        for (const taskId of taskIds) {
          const createdStub = await ensureFileBackedTask({
            sessionId,
            taskId,
            filterCwd,
            subject: newSubject,
            description: newDescription,
            activeForm: newActiveForm,
            status: newStatus ?? "in_progress",
          })
          if (createdStub) {
            continue
          }

          const { sessionId: effectiveSessionId, task } = await resolveTaskById(
            taskId,
            sessionId,
            filterCwd
          )
          if (newSubject) task.subject = newSubject
          if (newDescription) task.description = newDescription
          if (newActiveForm) task.activeForm = newActiveForm
          if (newStatus) {
            const oldStatus = task.status
            if (oldStatus === "in_progress" && task.statusChangedAt) {
              const elapsed = Date.now() - new Date(task.statusChangedAt).getTime()
              task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, elapsed)
            }
            task.status = newStatus
            task.statusChangedAt = new Date().toISOString()
            await writeTask(effectiveSessionId, task, process.cwd())
            await writeAudit(effectiveSessionId, {
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
          } else {
            await writeTask(effectiveSessionId, task, process.cwd())
            await writeAudit(effectiveSessionId, {
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
        }
        if (stateFlag) await applyStateUpdate(stateFlag, process.cwd())
        break
      }

      case "complete-all": {
        const sessionId = await resolveSession(rest)
        const evidence = extractFlag(rest, "--evidence")
        await completeAll(sessionId, filterCwd, evidence ?? undefined)
        break
      }

      case "adopt": {
        const sessionId = await resolveSession(rest)
        await adoptOrphanedTasks(sessionId, process.cwd())
        break
      }

      default:
        throw new Error(`Unknown subcommand: ${subcommand}\nRun "swiz help tasks" for usage.`)
    }
  },
}
