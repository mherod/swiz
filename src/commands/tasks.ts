import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIM, RESET } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { PROJECT_STATES } from "../settings.ts"
import { readAuditLog } from "../tasks/task-audit-verification.ts"
import { type DateFormat, listAllSessionsTasks, listTasks } from "../tasks/task-renderer.ts"
import type { Task } from "../tasks/task-repository.ts"
import {
  compareTaskIds,
  isIncompleteTaskStatus,
  parseTaskId,
  readTasks,
  sessionPrefix,
} from "../tasks/task-repository.ts"
import {
  findTaskAcrossSessions,
  getOrphanSessionIds,
  getSessionIdsByCwdScan,
  getSessionIdsForProject,
  getSessions,
  resolveTaskById,
} from "../tasks/task-resolver.ts"
import {
  adoptOrphanedTasks,
  applyStateUpdate,
  completeTaskWithAutoTransition,
  createTask,
  ensureFileBackedTask,
  updateStatus,
  writeTaskUpdate,
} from "../tasks/task-service.ts"
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

  // Compaction fallback: if no sessions found for cwd, fall back to the most
  // recently modified session across all projects.
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

  const hasIncomplete = tasks.some((t) => isIncompleteTaskStatus(t.status))
  if (hasIncomplete) return

  const sessions = await getSessions(process.cwd())
  for (const prevSessionId of sessions.slice(1)) {
    const prev = await readTasks(prevSessionId)
    const prevIncomplete = prev.filter((t) => isIncompleteTaskStatus(t.status))
    if (prevIncomplete.length === 0) continue

    console.log(
      `  ${DIM}Incomplete tasks in previous session: ${prevSessionId.slice(0, 8)}...${RESET}`
    )
    for (const task of prevIncomplete) {
      console.log(
        `    ${DIM}swiz tasks complete ${task.id} --session ${prevSessionId} --evidence "note:done"${RESET}`
      )
    }
    const agent = detectCurrentAgent()
    const nativeTool = agent?.toolAliases.Task
    if (nativeTool) {
      console.log(
        `  ${DIM}hint: prefer native ${nativeTool} tool over shell commands when available${RESET}`
      )
    }
    console.log()
    break
  }
}

function isListInvocation(subcommand: string | undefined): boolean {
  return (
    !subcommand ||
    subcommand === "--session" ||
    subcommand === "--all-projects" ||
    subcommand === "--all-sessions" ||
    subcommand === "--recovered" ||
    subcommand === "--date-format"
  )
}

function resolveFilterCwd(args: string[]): string | undefined {
  return args.includes("--all-projects") ? undefined : process.cwd()
}

async function runListTasks(args: string[]): Promise<void> {
  const allProjects = args.includes("--all-projects")
  const allSessions = args.includes("--all-sessions")
  const recovered = args.includes("--recovered")
  const filterCwd = resolveFilterCwd(args)
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
}

async function runCreateTask(rest: string[]): Promise<void> {
  const [subject, description, ...sessionArgs] = rest
  const stateFlag = extractFlag(rest, "--state")
  const statusFlag = extractFlag(rest, "--status")

  if (!subject || !description) {
    throw new Error('Usage: swiz tasks create "<subject>" "<description>" --state <state>')
  }

  if (!stateFlag) {
    const hint = statusFlag ? ' (did you mean "--state"?)' : ""
    throw new Error(
      `--state <state> is required${hint}.\n` +
        `It sets the session's active working phase (not the task's todo status).\n` +
        `Valid phases: ${PROJECT_STATES.join(" | ")}\n` +
        `Example: swiz tasks create "<subject>" "<description>" --state developing`
    )
  }
  const sessionId = await resolveSession(sessionArgs)
  await createTask(sessionId, subject, description)
  await applyStateUpdate(stateFlag, process.cwd())
}

async function handleCompleteError(
  e: unknown,
  opts: {
    sessionId: string
    taskId: string
    evidence: string | undefined
    verify: string | undefined
    filterCwd: string | undefined
    skipLastTaskGuard?: boolean
  }
): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes("Invalid transition") && msg.includes("pending")) {
    console.log(`  ⚡ Auto-transitioning #${opts.taskId}: pending → in_progress → completed`)
    await completeTaskWithAutoTransition(opts.sessionId, opts.taskId, {
      evidence: opts.evidence,
      verifyText: opts.verify,
      filterCwd: opts.filterCwd,
      skipLastTaskGuard: opts.skipLastTaskGuard,
    })
    return
  }
  if (msg.includes("not found")) {
    const sessionSuffix = opts.sessionId ? ` --session ${opts.sessionId.slice(0, 8)}` : ""
    throw new Error(`${msg}\nHint: specify the session with --session ${sessionSuffix.trim()}`)
  }
  throw e
}

async function runCompleteTask(rest: string[], filterCwd?: string): Promise<void> {
  const [taskId, ...sessionArgs] = rest
  if (!taskId) {
    throw new Error(
      "Usage: swiz tasks complete <task-id> [--evidence TEXT] [--state STATE] [--verify TEXT] [--subject TEXT] [--dry-run]"
    )
  }
  const statusFlag = extractFlag(rest, "--status")
  if (statusFlag) {
    throw new Error(`Unknown option: --status (did you mean "--state" or "swiz tasks status"?)`)
  }
  const dryRun = rest.includes("--dry-run")
  const evidence = extractFlag(rest, "--evidence")
  const stateFlag = extractFlag(rest, "--state")
  const subjectFlag = extractFlag(rest, "--subject")

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
    return
  }

  let verify = extractFlag(rest, "--verify")
  const explicitSession = extractFlag(rest, "--session")
  const sessionId = await resolveSession(sessionArgs)
  // Skip the last-task-standing guard for cross-session completions (Fixes #420)
  const skipLastTaskGuard = !!explicitSession

  await ensureFileBackedTask({
    sessionId,
    taskId,
    filterCwd,
    subject: subjectFlag,
    allowPlaceholderSubject: true,
  })

  if (!verify) {
    const { task } = await resolveTaskById(taskId, sessionId, filterCwd)
    verify = task.subject
  }

  try {
    await updateStatus(sessionId, taskId, "completed", {
      evidence,
      verifyText: verify,
      filterCwd,
    })
  } catch (e) {
    await handleCompleteError(e, {
      sessionId,
      taskId,
      evidence,
      verify,
      filterCwd,
      skipLastTaskGuard,
    })
    return
  }
  if (stateFlag) await applyStateUpdate(stateFlag, process.cwd())
}

async function runStatusTask(rest: string[], filterCwd?: string): Promise<void> {
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
}

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
  "  --status STATUS      Change task todo-status: pending | in_progress | completed | cancelled\n" +
  "                         (tasks must reach in_progress before they can be completed)\n" +
  `  --state STATE        Update the session working phase (independent of task status);\n` +
  `                         valid phases: ${PROJECT_STATES.join(" | ")}\n\n` +
  "At least one of --subject, --description, --active-form, or --status is required.\n" +
  "At least one field change is required."

interface ParsedUpdateArgs {
  taskIds: string[]
  flagArgs: string[]
}

interface UpdateFieldChanges {
  newSubject?: string
  newDescription?: string
  newActiveForm?: string
  newStatus?: Task["status"]
  stateFlag?: string
}

function parseUpdateArgs(rest: string[]): ParsedUpdateArgs {
  const firstFlagIdx = rest.findIndex((t) => t.startsWith("--"))
  const taskIds = (firstFlagIdx === -1 ? rest : rest.slice(0, firstFlagIdx)).filter(Boolean)
  const flagArgs = firstFlagIdx === -1 ? [] : rest.slice(firstFlagIdx)
  return { taskIds, flagArgs }
}

function assertKnownUpdateFlags(flagArgs: string[]): void {
  const knownFlags = new Set([
    "--subject",
    "--description",
    "--active-form",
    "--status",
    "--state",
    "--session",
  ])
  const flagNames = flagArgs.filter((t) => t.startsWith("--"))
  const unknownFlags = flagNames.filter((t) => !knownFlags.has(t))
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown flag(s): ${unknownFlags.join(", ")}\n\n${UPDATE_USAGE}`)
  }
}

function readUpdateFieldChanges(flagArgs: string[]): UpdateFieldChanges {
  const newSubject = extractFlag(flagArgs, "--subject")
  const newDescription = extractFlag(flagArgs, "--description")
  const newActiveForm = extractFlag(flagArgs, "--active-form")
  const newStatusRaw = extractFlag(flagArgs, "--status")
  const stateFlag = extractFlag(flagArgs, "--state")
  const newStatus = newStatusRaw as Task["status"] | undefined
  const valid: Task["status"][] = ["pending", "in_progress", "completed", "cancelled"]

  if (newStatus && !valid.includes(newStatus)) {
    throw new Error(`--status "${newStatusRaw}" is not valid. Must be one of: ${valid.join(" | ")}`)
  }
  if (!newSubject && !newDescription && !newActiveForm && !newStatus) {
    throw new Error(
      "At least one of --subject, --description, --active-form, or --status is required.\n\n" +
        UPDATE_USAGE
    )
  }

  return { newSubject, newDescription, newActiveForm, newStatus, stateFlag }
}

async function updateSingleTask(
  sessionId: string,
  taskId: string,
  filterCwd: string | undefined,
  changes: UpdateFieldChanges
): Promise<void> {
  const createdStub = await ensureFileBackedTask({
    sessionId,
    taskId,
    filterCwd,
    subject: changes.newSubject,
    description: changes.newDescription,
    activeForm: changes.newActiveForm,
    status: changes.newStatus ?? "in_progress",
  })
  if (createdStub) return

  const { sessionId: effectiveSessionId, task } = await resolveTaskById(
    taskId,
    sessionId,
    filterCwd
  )
  if (changes.newSubject) task.subject = changes.newSubject
  if (changes.newDescription) task.description = changes.newDescription
  if (changes.newActiveForm) task.activeForm = changes.newActiveForm
  await writeTaskUpdate(effectiveSessionId, taskId, task, changes.newStatus)
}

async function runUpdateTask(rest: string[], filterCwd?: string): Promise<void> {
  const { taskIds, flagArgs } = parseUpdateArgs(rest)

  if (taskIds.length === 0 || taskIds[0] === "--help" || taskIds[0] === "-h") {
    console.log(UPDATE_USAGE)
    return
  }

  assertKnownUpdateFlags(flagArgs)
  const changes = readUpdateFieldChanges(flagArgs)
  const sessionId = await resolveSession(flagArgs)

  for (const taskId of taskIds) {
    await updateSingleTask(sessionId, taskId, filterCwd, changes)
  }

  if (changes.stateFlag) await applyStateUpdate(changes.stateFlag, process.cwd())
}

// ─── Repair from audit trail ─────────────────────────────────────────────────

async function runRepairTasks(rest: string[]): Promise<void> {
  const sessionId = await resolveSession(rest)
  const { createDefaultTaskStore } = await import("../task-roots.ts")
  const tasksDir = createDefaultTaskStore().tasksDir

  const auditEntries = await readAuditLog(sessionId, tasksDir)
  if (auditEntries.length === 0) {
    console.log("  No audit log found for this session — nothing to repair.")
    return
  }

  // Reconstruct authoritative task state from audit trail
  const reconstructed = new Map<string, { subject: string; status: string }>()
  for (const entry of auditEntries) {
    const existing = reconstructed.get(entry.taskId)
    reconstructed.set(entry.taskId, {
      subject: entry.subject ?? existing?.subject ?? `Task ${entry.taskId}`,
      status: entry.newStatus ?? existing?.status ?? "pending",
    })
  }

  // Compare against current task files
  const currentTasks = await readTasks(sessionId, tasksDir)
  const currentById = new Map(currentTasks.map((t) => [t.id, t]))
  const sessionDir = join(tasksDir, sessionId)

  let repaired = 0
  let verified = 0

  for (const [taskId, auditState] of reconstructed) {
    const fileTask = currentById.get(taskId)

    if (!fileTask) {
      // Task file missing — reconstruct from audit
      const task: Task = {
        id: taskId,
        subject: auditState.subject,
        description: "Reconstructed from audit trail.",
        status: auditState.status as Task["status"],
        blocks: [],
        blockedBy: [],
      }
      await writeFile(join(sessionDir, `${taskId}.json`), JSON.stringify(task, null, 2))
      console.log(`  ✏️  Reconstructed #${taskId}: ${auditState.subject} [${auditState.status}]`)
      repaired++
    } else if (fileTask.status !== auditState.status) {
      // Status mismatch — audit trail is authoritative
      fileTask.status = auditState.status as Task["status"]
      await writeFile(join(sessionDir, `${taskId}.json`), JSON.stringify(fileTask, null, 2))
      console.log(
        `  🔧 Fixed #${taskId} status: was "${currentById.get(taskId)!.status}", now "${auditState.status}"`
      )
      repaired++
    } else {
      verified++
    }
  }

  console.log(
    `\n  Repair complete: ${repaired} fixed, ${verified} verified, ${reconstructed.size} total tasks.`
  )
}

const SUBCOMMAND_HANDLERS: Record<string, (rest: string[], filterCwd?: string) => Promise<void>> = {
  create: (rest) => runCreateTask(rest),
  TaskCreate: (rest) => {
    console.log(
      `  ${DIM}Note: "TaskCreate" is a native tool. Use "swiz tasks create" for CLI usage.${RESET}\n`
    )
    return runCreateTask(rest)
  },
  complete: (rest, filterCwd) => runCompleteTask(rest, filterCwd),
  TaskUpdate: (rest, filterCwd) => {
    // Determine if it's a completion (TaskUpdate status: completed) or general update
    const statusFlag = extractFlag(rest, "--status")
    const filteredRest = rest.filter((arg, i) => {
      if (arg === "--status") return false
      if (i > 0 && rest[i - 1] === "--status") return false
      return true
    })
    if (statusFlag === "completed") {
      console.log(
        `  ${DIM}Note: "TaskUpdate --status completed" is a native tool call. Use "swiz tasks complete" for CLI usage.${RESET}\n`
      )
      return runCompleteTask(filteredRest, filterCwd)
    }
    console.log(
      `  ${DIM}Note: "TaskUpdate" is a native tool. Use "swiz tasks update" for CLI usage.${RESET}\n`
    )
    return runUpdateTask(filteredRest, filterCwd)
  },
  status: (rest, filterCwd) => runStatusTask(rest, filterCwd),
  update: (rest, filterCwd) => runUpdateTask(rest, filterCwd),
  adopt: async (rest) => {
    const sessionId = await resolveSession(rest)
    await adoptOrphanedTasks(sessionId, process.cwd())
  },
  repair: (rest) => runRepairTasks(rest),
}

// ─── Claude Code native-tool guard ───────────────────────────────────────────

/** Subcommands with no native equivalent — only these may run via CLI inside Claude Code. */
const CLAUDE_CODE_EXEMPT_SUBCOMMANDS = new Set(["adopt", "repair", "TaskCreate", "TaskUpdate"])

function enforceNativeTaskTools(subcommand: string | undefined): void {
  const agent = detectCurrentAgent()
  if (agent?.id !== "claude") return

  if (subcommand && CLAUDE_CODE_EXEMPT_SUBCOMMANDS.has(subcommand)) return

  const nativeTools = "TaskCreate, TaskUpdate, TaskList, TaskGet"
  const hint = subcommand
    ? `"swiz tasks ${subcommand}" is not available inside Claude Code.`
    : `"swiz tasks" (list) is not available inside Claude Code.`

  throw new Error(
    `${hint}\n` +
      `Use native task tools instead: ${nativeTools}.\n` +
      `Only "swiz tasks adopt" is allowed via CLI (orphan recovery after compaction).`
  )
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const tasksCommand: Command = {
  name: "tasks",
  description: "View and manage agent tasks",
  usage:
    "swiz tasks [create|complete|status|adopt] [--session <id>] [--all-projects] [--all-sessions] [--recovered] [--date-format <relative|absolute>] [--evidence <text>] [--verify <text>] [--state <state>]",
  options: [
    { flags: "create <subject> <desc>", description: "Create a new task in the current session" },
    {
      flags: "complete <id>",
      description: "Mark a task completed",
    },
    {
      flags: "--status <status>",
      description: "Hidden option to guide users (did you mean --state?)",
      hidden: true,
    } as any,
    {
      flags: "status <id> <status>",
      description: "Set status: pending | in_progress | completed | cancelled",
    },
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
      description: "Optional completion evidence (free-form text)",
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

    enforceNativeTaskTools(subcommand)

    if (isListInvocation(subcommand)) {
      await runListTasks(args)
      return
    }

    const rest = args.slice(1)
    const handler = subcommand ? SUBCOMMAND_HANDLERS[subcommand] : undefined
    if (!handler) {
      throw new Error(`Unknown subcommand: ${subcommand}\nRun "swiz help tasks" for usage.`)
    }
    await handler(rest, resolveFilterCwd(args))
  },
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
