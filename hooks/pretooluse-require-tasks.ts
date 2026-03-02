#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least one incomplete task (pending or in_progress)
//   2. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import { dirname, join } from "node:path"
import {
  denyPreToolUse as deny,
  extractToolNamesFromTranscript,
  GH_CMD_RE,
  GIT_READ_RE,
  GIT_SYNC_RE,
  GIT_WRITE_RE,
  isEditTool,
  isGitRepo,
  isShellTool,
  isWriteTool,
  READ_CMD_RE,
  readSessionTasks,
  SWIZ_ISSUE_RE,
  TASK_TOOLS,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

const STALENESS_THRESHOLD = 20

const input = await Bun.stdin.json()
const toolName: string = input?.tool_name ?? ""
const sessionId: string = input?.session_id ?? ""
const transcriptPath: string = input?.transcript_path ?? ""
const cwd: string = input?.cwd ?? process.cwd()

if (!sessionId) process.exit(0)

// ── GUARD: Only enforce inside a git repo that has a CLAUDE.md ───────────────
// Enforcement in non-project directories (e.g. ~) creates an unrecoverable
// deadlock: the unlock steps (skills, markdown writes) fail without git context.
if (!(await isGitRepo(cwd))) process.exit(0)
{
  let dir = cwd
  let foundClaudeMd = false
  while (true) {
    if (await Bun.file(join(dir, "CLAUDE.md")).exists()) {
      foundClaudeMd = true
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!foundClaudeMd) process.exit(0)
}

const isBlockedTool = isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName)
if (!isBlockedTool) process.exit(0)

// ── EXEMPTION: Read-only inspection commands ──────────────────────────────────
// Orientation commands that don't mutate state are safe to run without a task.
if (isShellTool(toolName)) {
  const command: string = input?.tool_input?.command ?? ""

  // git read-only subcommands — allowed if no write subcommand also appears
  if (GIT_READ_RE.test(command) && !GIT_WRITE_RE.test(command)) {
    process.exit(0)
  }

  // ls and grep/rg — pure read, safe without a task
  if (READ_CMD_RE.test(command)) {
    process.exit(0)
  }

  // git push/pull/fetch — mechanical sync ops; don't require task tracking
  if (GIT_SYNC_RE.test(command)) {
    process.exit(0)
  }

  // gh commands — CI/PR inspection and management; end-of-session publishing steps
  if (GH_CMD_RE.test(command)) {
    process.exit(0)
  }

  // swiz issue close/comment — thin wrappers around gh issue; same exemption applies
  if (SWIZ_ISSUE_RE.test(command)) {
    process.exit(0)
  }
}

// ── EXEMPTION: Memory markdown edits ─────────────────────────────────────────
// CLAUDE.md and MEMORY.md edits are memory-maintenance work and must never be
// gated on task existence — the task hook must not prevent the agent from
// recording learnings or following memory-enforcement instructions.
if (isEditTool(toolName) || isWriteTool(toolName)) {
  const filePath: string = input?.tool_input?.file_path ?? ""
  if (/(?:^|[\\/])(?:CLAUDE|MEMORY)\.md$/i.test(filePath)) {
    process.exit(0)
  }
}

// ── CHECK 1: Tasks have been created for this session (file-based) ────────────
// Blocks when NO tasks have ever been created — the agent is working without a plan.
// Does NOT block when all tasks are completed: that is legitimate wrap-up work
// (CI verification, issue comments, closing issues, etc.). CHECK 2 (staleness)
// still fires if the agent does excessive unplanned work after completion.

if (!process.env.HOME) process.exit(0)
const allTasks = await readSessionTasks(sessionId)
const activeTasks = allTasks
  .filter((t) => t.status === "pending" || t.status === "in_progress")
  .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

if (allTasks.length === 0) {
  deny(
    `STOP. ${toolName} is BLOCKED because this session has no incomplete tasks.\n\n` +
      `You must keep at least one task in pending or in_progress status before using bash/shell/edit tools.\n\n` +
      `Required now:\n` +
      `1. Create or update a task so its status is pending or in_progress.\n` +
      `2. Include a concrete description of the current work and next step.\n\n` +
      `After at least one task is incomplete, ${toolName} will be unblocked automatically.`
  )
}

// ── WRAP-UP EXEMPTION: All tasks completed ────────────────────────────────────
// When every task in the session is done, the agent is in wrap-up mode
// (CI checks, closing issues, pushing, etc.). Staleness enforcement is
// meaningless at this point — skip CHECK 2 entirely.
if (activeTasks.length === 0) process.exit(0)

// ── CHECK 2: Task staleness (transcript scan) ─────────────────────────────────
// Only enforced when a transcript is available and task tools have been used
// at least once (i.e. the agent has already engaged with the task system).

if (transcriptPath) {
  const toolNames = await extractToolNamesFromTranscript(transcriptPath)
  const total = toolNames.length

  let lastTaskIndex = -1
  for (let i = total - 1; i >= 0; i--) {
    const name = toolNames[i]
    if (name && TASK_TOOLS.has(name)) {
      lastTaskIndex = i
      break
    }
  }

  // Only flag staleness if the agent has previously used task tools
  if (lastTaskIndex >= 0) {
    const callsSinceTask = total - 1 - lastTaskIndex
    if (callsSinceTask >= STALENESS_THRESHOLD) {
      const taskUpdateName = toolNameForCurrentAgent("TaskUpdate")
      const taskCreateName = toolNameForCurrentAgent("TaskCreate")
      // Show active tasks if any; fall back to all tasks so context is never empty
      const displayTasks =
        activeTasks.length > 0
          ? activeTasks
          : allTasks.map((t) => `#${t.id} (${t.status}): ${t.subject}`)
      const taskList = displayTasks.map((t) => `  ${t}`).join("\n")
      deny(
        `STOP. Tasks have gone stale. ${callsSinceTask} tool calls since last task update. ` +
          `${toolName} is BLOCKED.\n\n` +
          `Active tasks:\n${taskList}\n\n` +
          `Tasks are not suggestions — they are your execution plan. Stale tasks mean you are operating without accountability.\n\n` +
          `YOU MUST DO THE FOLLOWING BEFORE CONTINUING:\n` +
          `1. Use ${taskUpdateName} to update in-progress tasks with the latest progress and mark completed work done.\n` +
          `2. Ensure the current work has an in_progress task with a clear description.\n` +
          `3. Use ${taskCreateName} to create at least one further task for the next concrete step based on the work underway.\n\n` +
          `After updating tasks, ${toolName} will be unblocked automatically.`
      )
    }
  }
}
