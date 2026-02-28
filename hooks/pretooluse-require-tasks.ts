#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least one incomplete task (pending or in_progress)
//   2. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import { join } from "node:path"
import {
  denyPreToolUse as deny,
  extractToolNamesFromTranscript,
  isEditTool,
  isShellTool,
  isWriteTool,
  TASK_TOOLS,
} from "./hook-utils.ts"

const STALENESS_THRESHOLD = 20

const input = await Bun.stdin.json()
const toolName: string = input?.tool_name ?? ""
const sessionId: string = input?.session_id ?? ""
const transcriptPath: string = input?.transcript_path ?? ""

if (!sessionId) process.exit(0)

const isBlockedTool = isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName)
if (!isBlockedTool) process.exit(0)

// ── EXEMPTION: Read-only inspection commands ──────────────────────────────────
// Orientation commands that don't mutate state are safe to run without a task.
if (isShellTool(toolName)) {
  const command: string = input?.tool_input?.command ?? ""

  // git read-only subcommands — allowed if no write subcommand also appears
  const GIT_READ_RE =
    /(?:^|\|\||&&|;)\s*git\s+(log|status|diff|show|branch|remote\b|rev-parse|rev-list|reflog|ls-files|describe|tag\b)(\s|$)/
  const GIT_WRITE_RE =
    /\bgit\s+(add|commit|push|pull|fetch|checkout|switch|restore|reset|rebase|merge|stash\s+(?!list)|cherry-pick|revert|rm|mv|apply)\b/
  if (GIT_READ_RE.test(command) && !GIT_WRITE_RE.test(command)) {
    process.exit(0)
  }

  // ls and grep/rg — pure read, safe without a task
  const READ_CMD_RE = /(?:^|\|\||&&|;)\s*(ls|rg|grep)\b/
  if (READ_CMD_RE.test(command)) {
    process.exit(0)
  }

  // git push/pull/fetch — mechanical sync ops; don't require task tracking
  const GIT_SYNC_RE = /(?:^|\|\||&&|;)\s*git\s+(push|pull|fetch)\b/
  if (GIT_SYNC_RE.test(command)) {
    process.exit(0)
  }

  // gh commands — CI/PR inspection and management; end-of-session publishing steps
  const GH_CMD_RE = /(?:^|\|\||&&|;)\s*gh\b/
  if (GH_CMD_RE.test(command)) {
    process.exit(0)
  }
}

// ── CHECK 1: Incomplete tasks exist (file-based) ──────────────────────────────

const home = process.env.HOME
if (!home) process.exit(0)
const tasksDir = join(home, ".claude", "tasks", sessionId)
const activeTasks: string[] = []

try {
  const glob = new Bun.Glob("*.json")
  for await (const file of glob.scan(tasksDir)) {
    try {
      const task = await Bun.file(join(tasksDir, file)).json()
      const status = task?.status
      if (status === "pending" || status === "in_progress") {
        activeTasks.push(`#${task.id} (${status}): ${task.subject}`)
      }
    } catch {
      // skip unreadable task files
    }
  }
} catch {
  // tasksDir may not exist yet
}

if (activeTasks.length === 0) {
  deny(
    `STOP. ${toolName} is BLOCKED because this session has no incomplete tasks.\n\n` +
      `You must keep at least one task in pending or in_progress status before using bash/shell/edit tools.\n\n` +
      `Required now:\n` +
      `1. Create or update a task so its status is pending or in_progress.\n` +
      `2. Include a concrete description of the current work and next step.\n\n` +
      `After at least one task is incomplete, ${toolName} will be unblocked automatically.`
  )
}

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
      const taskList = activeTasks.map((t) => `  ${t}`).join("\n")
      deny(
        `STOP. Tasks have gone stale. ${callsSinceTask} tool calls since last task update. ` +
          `${toolName} is BLOCKED.\n\n` +
          `Active tasks:\n${taskList}\n\n` +
          `Tasks are not suggestions — they are your execution plan. Stale tasks mean you are operating without accountability.\n\n` +
          `YOU MUST DO THE FOLLOWING BEFORE CONTINUING:\n` +
          `1. Update tasks with latest progress — mark completed work done, update in-progress tasks with current status.\n` +
          `2. Ensure the current work has an in_progress task with a clear description.\n` +
          `3. Plan ahead — ensure upcoming tasks exist beyond the current work.\n\n` +
          `After updating tasks, ${toolName} will be unblocked automatically.`
      )
    }
  }
}
