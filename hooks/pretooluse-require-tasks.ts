#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least one incomplete task (pending or in_progress)
//   2. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import {
  denyPreToolUse as deny,
  extractToolNamesFromTranscript,
  findLastTaskToolCallIndex,
  formatActionPlan,
  formatTaskSubjectsForDisplay,
  hasFileInTree,
  isEditTool,
  isGitRepo,
  isIncompleteTaskStatus,
  isShellTool,
  isTaskTrackingExemptShellCommand,
  isWriteTool,
  readSessionTasks,
} from "./hook-utils.ts"

const STALENESS_THRESHOLD = 20
const MEMORY_MARKDOWN_RE = /(?:^|[\\/])(?:CLAUDE|MEMORY)\.md$/i

async function main() {
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
  if (!(await hasFileInTree(cwd, "CLAUDE.md"))) process.exit(0)

  const isBlockedTool = isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName)
  if (!isBlockedTool) process.exit(0)

  // ── EXEMPTION: Read-only inspection commands ──────────────────────────────────
  // Orientation commands that don't mutate state are safe to run without a task.
  if (isShellTool(toolName)) {
    const command: string = input?.tool_input?.command ?? ""
    if (isTaskTrackingExemptShellCommand(command)) process.exit(0)
  }

  // ── EXEMPTION: Memory markdown edits ─────────────────────────────────────────
  // CLAUDE.md and MEMORY.md edits are memory-maintenance work and must never be
  // gated on task existence — the task hook must not prevent the agent from
  // recording learnings or following memory-enforcement instructions.
  if (isEditTool(toolName) || isWriteTool(toolName)) {
    const filePath: string = input?.tool_input?.file_path ?? ""
    if (MEMORY_MARKDOWN_RE.test(filePath)) process.exit(0)
  }

  // ── CHECK 1: Tasks have been created for this session (file-based) ────────────
  // Blocks when NO tasks have ever been created — the agent is working without a plan.
  // Does NOT block when all tasks are completed: that is legitimate wrap-up work
  // (CI verification, issue comments, closing issues, etc.). CHECK 2 (staleness)
  // still fires if the agent does excessive unplanned work after completion.

  if (!process.env.HOME) process.exit(0)
  const allTasks = await readSessionTasks(sessionId)
  const activeTasks = allTasks
    .filter((t) => isIncompleteTaskStatus(t.status))
    .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

  if (allTasks.length === 0) {
    deny(
      `STOP. ${toolName} is BLOCKED because this session has no incomplete tasks.\n\n` +
        `You must keep at least one task in pending or in_progress status before using bash/shell/edit tools.\n\n` +
        formatActionPlan(
          [
            "Create or update a task so its status is pending or in_progress.",
            "Include a concrete description of the current work and next step.",
          ],
          { translateToolNames: true }
        ) +
        `\n` +
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
    const lastTaskIndex = findLastTaskToolCallIndex(toolNames)

    // Only flag staleness if the agent has previously used task tools
    if (lastTaskIndex >= 0) {
      const callsSinceTask = total - 1 - lastTaskIndex
      if (callsSinceTask >= STALENESS_THRESHOLD) {
        const taskList = formatTaskSubjectsForDisplay(allTasks, activeTasks)
        deny(
          `STOP. Tasks have gone stale. ${callsSinceTask} tool calls since last task update. ` +
            `${toolName} is BLOCKED.\n\n` +
            `We currently have these tasks in progress:\n${taskList}\n\n` +
            `However, it's been a while since we've updated the task list. Good task hygiene means the list should stay fully reflective of what we're currently doing.\n\n` +
            `Tasks are not suggestions - they are our execution plan. Stale tasks mean we are operating without clear accountability.\n\n` +
            `Our current work has clearly grown in scope beyond the original task definition. We should update the in-progress task with current status, and create a new task that represents the work now underway.\n\n` +
            formatActionPlan(
              [
                "Use TaskUpdate to update in-progress tasks with the latest progress and mark completed work done.",
                "Ensure the current work has an in_progress task with a clear description.",
                "Use TaskCreate to create at least one further task for the next concrete step based on the work underway.",
              ],
              { translateToolNames: true }
            ) +
            `\n` +
            `After updating tasks, ${toolName} will be unblocked automatically.`
        )
      }
    }
  }

  process.exit(0)
}

void main().catch(() => {
  process.exit(0)
})
