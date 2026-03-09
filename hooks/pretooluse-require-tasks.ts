#!/usr/bin/env bun

// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least two incomplete tasks (pending or in_progress)
//   2. At least one incomplete task is pending to represent the next intended step
//   3. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import { getHomeDirOrNull } from "../src/home.ts"
import { readProjectState } from "../src/settings.ts"
import {
  denyPreToolUse as deny,
  extractToolNamesFromTranscript,
  findLastTaskToolCallIndex,
  findPriorSessionTasks,
  formatActionPlan,
  formatTaskCompleteCommands,
  formatTaskList,
  formatTaskSubjectsForDisplay,
  getTranscriptSummary,
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
const LARGE_CONTENT_LINE_THRESHOLD = 10
const IN_PROGRESS_CAP = 4
const MIN_INCOMPLETE_TASKS = 2
const MIN_PENDING_TASKS = 1
const MEMORY_MARKDOWN_RE = /(?:^|[\\/])(?:CLAUDE|MEMORY)\.md$/i

/**
 * Detect whether an Edit/Write payload carries substantial content (10+ lines).
 * Blocking a large payload throws away expensive work — better to let it through
 * and rely on post-tool advisory for stale-task guidance.
 */
export function isLargeContentPayload(input: Record<string, unknown>): boolean {
  const toolInput = input?.tool_input as Record<string, unknown> | undefined
  const content = ((toolInput?.new_string ?? toolInput?.content) as string) ?? ""
  return content.split("\n").length >= LARGE_CONTENT_LINE_THRESHOLD
}

async function main() {
  const input = await Bun.stdin.json()
  const toolName: string = input?.tool_name ?? ""
  const sessionId: string = input?.session_id ?? ""
  const transcriptPath: string = input?.transcript_path ?? ""
  const cwd: string = input?.cwd ?? process.cwd()

  if (!sessionId) process.exit(0)
  // Sanitize sessionId to prevent path traversal
  if (/[/\\]|\.\./.test(sessionId)) process.exit(0)

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

  // ── CHECK 1: Task minimums for this session (file-based) ──────────────────────
  // The session must always keep at least:
  //   - MIN_INCOMPLETE_TASKS incomplete tasks (pending or in_progress), and
  //   - MIN_PENDING_TASKS pending task to represent the next intended step.

  if (!getHomeDirOrNull()) process.exit(0)
  const allTasks = await readSessionTasks(sessionId)
  const activeTasks = allTasks
    .filter((t) => isIncompleteTaskStatus(t.status))
    .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

  if (allTasks.length === 0) {
    // If the prior session for this project had incomplete tasks, direct the
    // agent to restore them before starting new work.
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const taskLines = formatTaskList(priorTasks)
      const completeExamples = formatTaskCompleteCommands(
        priorTasks,
        priorSessionId,
        "note:completed in prior session",
        { indent: "  " }
      )
      deny(
        `STOP. This session has no tasks, but a prior session (${priorSessionId}) had ${priorTasks.length} incomplete task(s):\n` +
          taskLines +
          `\n\n` +
          formatActionPlan(
            [
              `If the work is already done, mark the prior tasks complete:\n${completeExamples}`,
              "If the work is still needed, use TaskCreate to re-create these tasks and mark the current one in_progress.",
              `Retry this ${toolName} call — it will succeed once an in_progress task exists.`,
            ],
            { translateToolNames: true }
          )
      )
    }

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

  const incompleteTasks = allTasks.filter((t) => isIncompleteTaskStatus(t.status))
  const pendingTasks = incompleteTasks.filter((t) => t.status === "pending")
  const incompleteTaskList = incompleteTasks
    .map((t) => `  • #${t.id} (${t.status}): ${t.subject}`)
    .join("\n")

  if (incompleteTasks.length < MIN_INCOMPLETE_TASKS || pendingTasks.length < MIN_PENDING_TASKS) {
    deny(
      `STOP. ${toolName} is BLOCKED because task minimums are not met.\n\n` +
        `Required:\n` +
        `  • At least ${MIN_INCOMPLETE_TASKS} incomplete tasks (pending/in_progress)\n` +
        `  • At least ${MIN_PENDING_TASKS} pending task for the next intended step\n\n` +
        `Current:\n` +
        `  • Incomplete tasks: ${incompleteTasks.length}\n` +
        `  • Pending tasks: ${pendingTasks.length}\n` +
        `${incompleteTaskList ? `\nCurrent incomplete tasks:\n${incompleteTaskList}\n` : "\n"}` +
        formatActionPlan(
          [
            "Use TaskCreate to add any missing next-step tasks.",
            "Use TaskUpdate to keep exactly one current task in_progress and at least one clear next step in pending.",
            `Retry this ${toolName} call after task minimums are restored.`,
          ],
          { translateToolNames: true }
        )
    )
  }

  // ── CHECK 3: In-progress task cap ────────────────────────────────────────────
  // More than IN_PROGRESS_CAP simultaneous in_progress tasks weakens focus.
  // Require the agent to triage active tasks before continuing new work.
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress")
  if (inProgressTasks.length > IN_PROGRESS_CAP) {
    const taskList = inProgressTasks.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
    deny(
      `STOP. Too many in-progress tasks (${inProgressTasks.length}/${IN_PROGRESS_CAP} max). ${toolName} is BLOCKED.\n\n` +
        `Currently in progress:\n${taskList}\n\n` +
        `Having more than ${IN_PROGRESS_CAP} simultaneous in_progress tasks weakens focus and planning quality.\n\n` +
        formatActionPlan(
          [
            "Use TaskUpdate to mark completed tasks done (status: completed).",
            "Use TaskUpdate to move non-active tasks back to pending.",
            `Reduce in_progress count to ${IN_PROGRESS_CAP} or fewer, then retry.`,
          ],
          { translateToolNames: true }
        ) +
        `\n` +
        `After reducing active tasks, ${toolName} will be unblocked automatically.`
    )
  }

  // ── CHECK 2: Task staleness (transcript scan) ─────────────────────────────────
  // Only enforced when a transcript is available and task tools have been used
  // at least once (i.e. the agent has already engaged with the task system).

  if (transcriptPath) {
    const summary = getTranscriptSummary(input)
    const toolNames = summary?.toolNames ?? (await extractToolNamesFromTranscript(transcriptPath))
    const total = toolNames.length
    const lastTaskIndex = findLastTaskToolCallIndex(toolNames)

    // Only flag staleness if the agent has previously used task tools
    if (lastTaskIndex >= 0) {
      const callsSinceTask = total - 1 - lastTaskIndex
      if (callsSinceTask >= STALENESS_THRESHOLD) {
        // ── LARGE-CONTENT EXEMPTION ───────────────────────────────────────
        // Blocking a large Edit/Write throws away costly work. Let it
        // complete and rely on the post-tool advisor for stale-task guidance.
        // Shell tools remain hard-blocked regardless of payload size.
        if ((isEditTool(toolName) || isWriteTool(toolName)) && isLargeContentPayload(input)) {
          process.exit(0)
        }

        const taskList = formatTaskSubjectsForDisplay(allTasks, activeTasks)
        const projectState = await readProjectState(cwd).catch(() => null)
        const stateStep = projectState
          ? `Check project state (\`swiz state show\`): currently \`${projectState}\`. Run \`swiz state set <state>\` if the work phase has changed.`
          : `Set a project state to reflect the current phase: \`swiz state set <state>\` (\`swiz state list\` for options).`
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
                stateStep,
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
