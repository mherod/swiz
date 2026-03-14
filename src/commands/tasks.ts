import { DIM, RESET } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { PROJECT_STATES } from "../settings.ts"
import { type DateFormat, listAllSessionsTasks, listTasks } from "../tasks/task-renderer.ts"
import type { Task } from "../tasks/task-repository.ts"
import { compareTaskIds, parseTaskId, readTasks, sessionPrefix } from "../tasks/task-repository.ts"
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
  completeAll,
  createTask,
  ensureFileBackedTask,
  submitEvidence,
  updateStatus,
  writeTaskUpdate,
} from "../tasks/task-service.ts"
import type { Command } from "../types.ts"

export {
  validateEvidence,
  verifyCiGreenEvidence,
  verifyTaskSubject,
} from "../tasks/evidence-validator.ts"

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
    // Fast-path: close all at once
    console.log(
      `    ${DIM}swiz tasks complete-all --session ${prevSessionId}  # close all at once${RESET}`
    )
    // Per-task commands for selective completion
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
}

async function runCompleteTask(rest: string[], filterCwd?: string): Promise<void> {
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
  const sessionId = await resolveSession(sessionArgs)

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
    const msg = e instanceof Error ? e.message : String(e)
    // Guide the agent through the mandatory pending → in_progress → completed sequence
    if (msg.includes("Invalid transition") && msg.includes("pending")) {
      const sessionSuffix = sessionId ? ` --session ${sessionId.slice(0, 8)}` : ""
      throw new Error(
        `${msg}\n\n` +
          `Task must be set in_progress before it can be completed.\n` +
          `Run these two commands in sequence:\n` +
          `  swiz tasks status ${taskId} in_progress${sessionSuffix}\n` +
          `  swiz tasks complete ${taskId} --evidence "note:..."${sessionSuffix}`
      )
    }
    // Guide the agent to use complete-all when individual task lookup fails
    if (msg.includes("not found")) {
      const sessionSuffix = sessionId ? ` --session ${sessionId.slice(0, 8)}` : ""
      throw new Error(
        `${msg}\n\n` +
          `To close all incomplete tasks at once (avoids per-task disambiguation):\n` +
          `  swiz tasks complete-all${sessionSuffix}`
      )
    }
    throw e
  }
  if (stateFlag) await applyStateUpdate(stateFlag, process.cwd())
}

async function runEvidenceTask(rest: string[], filterCwd?: string): Promise<void> {
  const [taskId, evidenceText, ...sessionArgs] = rest
  if (!taskId || !evidenceText) {
    throw new Error(
      'Usage: swiz tasks evidence <task-id> "<evidence>" [--subject TEXT]\n' +
        "Prefixes: commit:, pr:, file:, test:, note:, ci_green:, conclusion:, run:, no_ci:"
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
  'To add evidence to a completed task, use: swiz tasks evidence <task-id> "<evidence>"'

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

const SUBCOMMAND_HANDLERS: Record<string, (rest: string[], filterCwd?: string) => Promise<void>> = {
  create: (rest) => runCreateTask(rest),
  complete: (rest, filterCwd) => runCompleteTask(rest, filterCwd),
  evidence: (rest, filterCwd) => runEvidenceTask(rest, filterCwd),
  status: (rest, filterCwd) => runStatusTask(rest, filterCwd),
  update: (rest, filterCwd) => runUpdateTask(rest, filterCwd),
  "complete-all": async (rest, filterCwd) => {
    const sessionId = await resolveSession(rest)
    const evidence = extractFlag(rest, "--evidence")
    await completeAll(sessionId, filterCwd, evidence ?? undefined)
  },
  adopt: async (rest) => {
    const sessionId = await resolveSession(rest)
    await adoptOrphanedTasks(sessionId, process.cwd())
  },
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
      description:
        "Submit evidence to a task (commit:, pr:, file:, test:, note:, ci_green:, conclusion:, run:, no_ci:)",
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
      description:
        "Completion evidence (commit:, pr:, file:, test:, note:, ci_green:, conclusion:, run:, no_ci:)",
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
