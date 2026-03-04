#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least one incomplete task (pending or in_progress)
//   2. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import { join } from "node:path"

import {
  computeSubjectFingerprint,
  denyPreToolUse as deny,
  extractToolNamesFromTranscript,
  findLastTaskToolCallIndex,
  findPriorSessionTasks,
  formatActionPlan,
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
  sessionPrefix,
} from "./hook-utils.ts"

const STALENESS_THRESHOLD = 20
const LARGE_CONTENT_LINE_THRESHOLD = 10
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

/**
 * Auto-create a bootstrap task when the session has no tasks at all.
 * Returns the created task ID, or null if creation failed.
 */
export async function createBootstrapTask(
  sessionId: string,
  home: string = process.env.HOME ?? ""
): Promise<string | null> {
  if (!home || !sessionId) return null
  // Sanitize sessionId to prevent path traversal
  if (/[/\\]|\.\./.test(sessionId)) return null
  const tasksDir = join(home, ".claude", "tasks", sessionId)
  try {
    const { mkdir, readdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Pick next available ID by scanning existing files
    const files = await readdir(tasksDir).catch(() => [] as string[])
    const ids = files
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => {
        const name = f.replace(".json", "")
        // Handle both prefixed (a3f2-5) and numeric (5) IDs
        const dashIdx = name.lastIndexOf("-")
        return dashIdx > 0 ? parseInt(name.slice(dashIdx + 1), 10) : parseInt(name, 10)
      })
      .filter((n) => !Number.isNaN(n))
    const nextSeq = ids.length > 0 ? Math.max(...ids) + 1 : 1
    const prefix = sessionPrefix(sessionId)
    const nextId = `${prefix}-${nextSeq}`
    const subject = "Session bootstrap — describe current work"
    const task = {
      id: nextId,
      subject,
      description:
        "Auto-created by pretooluse-require-tasks because no tasks existed. " +
        "Update this task with a description of the current work, then create follow-up tasks.",
      activeForm: "Bootstrapping session tasks",
      status: "in_progress",
      subjectFingerprint: computeSubjectFingerprint(subject),
      blocks: [],
      blockedBy: [],
    }
    await Bun.write(join(tasksDir, `${nextId}.json`), JSON.stringify(task, null, 2))
    return nextId
  } catch {
    return null
  }
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
    // Before auto-creating a bootstrap task, check if the prior session for this
    // project had incomplete tasks. If so, direct the agent to restore them
    // rather than resetting the plan with a new generic bootstrap task.
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const taskLines = priorTasks.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
      const completeExamples = priorTasks
        .map(
          (t) =>
            `  swiz tasks complete ${t.id} --session ${priorSessionId} --evidence "note:completed in prior session"`
        )
        .join("\n")
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

    // Auto-create a bootstrap task so the agent isn't hard-blocked.
    // The tool call is still denied this time — on retry the task exists and CHECK 1 passes.
    const bootstrapId = await createBootstrapTask(sessionId)
    if (bootstrapId) {
      deny(
        `Session had no tasks. A bootstrap task #${bootstrapId} (in_progress) was auto-created.\n\n` +
          formatActionPlan(
            [
              `Update task #${bootstrapId} with a description of your current work using TaskUpdate.`,
              "Create follow-up tasks for planned next steps using TaskCreate.",
              `Retry this ${toolName} call — it will succeed now that an in_progress task exists.`,
            ],
            { translateToolNames: true }
          )
      )
    }
    // Fallback: if auto-creation failed, block with original message
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
