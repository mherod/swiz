const PLENTY_PENDING_THRESHOLD = 2

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function buildTaskCreationCountdownMessage(
  total: number,
  threshold: number,
  taskCreateName: string
): string | undefined {
  const remaining = threshold - total
  if (remaining <= 0) return undefined

  if (remaining <= 1) {
    return `${taskCreateName} required in ${remaining} tool call(s) - tools will be blocked until tasks are defined. We should create focused tasks before continuing.`
  }
  if (remaining <= 3) {
    return `${taskCreateName} required in ${remaining} tool calls. We should plan the next tasks now to avoid interruption.`
  }
  if (total >= 2) {
    return `${total}/${threshold} tool calls before ${taskCreateName} is required. We should create tasks before the work expands further.`
  }
  return undefined
}

export function buildTaskAdvisorStalenessMessage(
  callsSinceTask: number,
  staleRemaining: number,
  toolName: string,
  isImplementationTool: boolean
): string | undefined {
  if (staleRemaining > 0) {
    if (staleRemaining <= 2) {
      return `Task update required in ${staleRemaining} tool call(s) - tools will be blocked until tasks are reviewed. We should update task status before the next implementation step.`
    }
    if (staleRemaining <= 4) {
      return `Task update due in ${staleRemaining} tool calls. We should mark completed tasks done, refresh in-progress tasks, or create new tasks for the work underway.`
    }
    return undefined
  }

  if (!isImplementationTool) return undefined

  const base =
    `Tasks need attention - it's been ${callsSinceTask} tool calls since the last task update. ` +
    "We should review progress, mark completed tasks done, update in-progress tasks with current status, or create new tasks for the work underway."

  if (callsSinceTask <= 20) return base

  return `${base} The task list is now far behind the work, so we should pause implementation and make it accurate before continuing with ${toolName}.`
}

export function buildUserPromptTaskContext(pendingCount: number, taskCreateName: string): string {
  if (pendingCount === 0) {
    return `No pending tasks in this session. We should use ${taskCreateName} to create a task for this prompt before starting work.`
  }
  return `We should use ${taskCreateName} to create a task for this prompt before starting work on it.`
}

export function buildTaskListBeforeStopMessage(): string {
  return (
    "We should run TaskList before stopping so task state is synced.\n\n" +
    "This session used task tools but never called TaskList. Run TaskList now, then retry stop."
  )
}

export function buildCountSummary(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
  issueHints?: string[]
}): string {
  const parts: string[] = [`Tasks: ${counts.inProgress} in_progress, ${counts.pending} pending.`]
  appendPlanningFeedback(parts, counts)
  appendHygieneFeedback(parts, counts)
  return parts.join(" ")
}

function appendPlanningFeedback(
  parts: string[],
  counts: {
    pending: number
    incomplete: number
    issueHints?: string[]
  }
): void {
  if (counts.pending === 0) {
    parts.push(
      "URGENT: Zero pending tasks. We should create two pending tasks now to keep a planning buffer: (1) a verification task for the current step, and (2) a broader next-step task for the natural follow-on work."
    )
  } else if (counts.pending === 1 && counts.incomplete <= 2) {
    parts.push(
      "Proactive task planning needed: only 1 pending task remains. We should create 1 more pending task to maintain the planning buffer. Aim for two pending tasks: one immediate verification step and one broader logical next task."
    )
  }

  if (
    (counts.pending === 0 || (counts.pending === 1 && counts.incomplete <= 2)) &&
    counts.issueHints &&
    counts.issueHints.length > 0
  ) {
    parts.push(`Open issues we could plan for: ${counts.issueHints.join("; ")}.`)
  }
}

function appendHygieneFeedback(
  parts: string[],
  counts: {
    pending: number
    inProgress: number
    incomplete: number
  }
): void {
  if (counts.inProgress === 0 && counts.incomplete > 0) {
    parts.push(
      "No in_progress task. We should transition a pending task to in_progress before starting implementation."
    )
  } else if (counts.pending >= PLENTY_PENDING_THRESHOLD && counts.inProgress >= 1) {
    parts.push(
      "Good task hygiene: we have a planning buffer and one clear in_progress focus. Keep updating status as work completes and add pending tasks before the queue runs low."
    )
  }
}

export function formatIncompleteReason(taskDetails: string[]): string {
  if (taskDetails.length === 0) return ""

  const header = "Incomplete tasks remain in the current session:\n\n"
  const taskList = taskDetails.map((d) => `  - ${d}`).join("\n")
  const footer =
    "\n\nWe should complete these tasks before stopping. Use TaskList to review the full list, then update each task with evidence when the work is done."

  return header + taskList + footer
}

export const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Do not use the `swiz tasks` CLI inside Claude Code.\n\n" +
  "We should use native task tools only:\n" +
  "  - TaskCreate - new tasks\n" +
  "  - TaskUpdate - status, subject, description, and marking completed\n" +
  "  - TaskList / TaskGet - query tasks\n\n" +
  "Work must stay in the tracked tool channel because auditing, hooks, and task sync depend on it.\n\n" +
  "The only `swiz tasks` subcommand still allowed here is `adopt` (orphan recovery after compaction)."

export function buildPendingCompletionTransitionMessage(taskId: string): string {
  return (
    `Cannot complete task #${taskId} directly from pending.\n\n` +
    "Required transition: pending -> in_progress -> completed.\n\n" +
    `We should use TaskUpdate to set task #${taskId} to in_progress first, then complete it.`
  )
}

export function buildStaleTaskBlockReason(opts: {
  callsSinceLastTaskTool: number
  toolName: string
  taskList: string
  actionPlan: string
}): string {
  return (
    `STOP. Tasks have gone stale. ${plural(opts.callsSinceLastTaskTool, "tool call")} since last task update. ` +
    `${opts.toolName} is BLOCKED.\n\n` +
    `Current in-progress task context:\n${opts.taskList}\n\n` +
    "We should make the task list match the work before continuing. That means updating the in-progress task with current status, marking completed work done, and creating the next concrete task if the scope has changed.\n\n" +
    opts.actionPlan +
    `\nAfter updating tasks, ${opts.toolName} will be unblocked automatically.`
  )
}
