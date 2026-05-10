import { type ActionPlanItem, formatActionPlan } from "../action-plan.ts"
import {
  type DuplicateSubjectGroup,
  formatDuplicateSubjectGroups,
} from "./task-subject-duplicates.ts"

const PLENTY_PENDING_THRESHOLD = 2

export const TASKLIST_STABILITY_STEP = "Run TaskList now."

export const TASKLIST_CONFIRM_STEP = "Run TaskList again after updating tasks."

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function retryAfterTaskList(toolName: string): string {
  return `Retry this ${toolName} call after the task queue is ready.`
}

export function buildTaskListRepairPlan(
  steps: ActionPlanItem[],
  opts: { confirm?: boolean } = {}
): ActionPlanItem[] {
  const confirm = opts.confirm ?? true
  return [TASKLIST_STABILITY_STEP, ...steps, ...(confirm ? [TASKLIST_CONFIRM_STEP] : [])]
}

function formatTranslatedActionPlan(
  steps: ActionPlanItem[],
  options: { header?: string; taskListFirst?: boolean; confirm?: boolean } = {}
): string {
  const actionSteps = options.taskListFirst
    ? buildTaskListRepairPlan(steps, { confirm: options.confirm })
    : steps
  return formatActionPlan(actionSteps, {
    translateToolNames: true,
    ...(options.header ? { header: options.header } : {}),
  })
}

function buildDeletionGovernanceMessage(opts: { taskId: string; retryStep: string }): string {
  return (
    `STOP. Do not delete task #${opts.taskId} yet.\n\n` +
    "Keep current work and follow-up work visible before removing this task.\n\n" +
    formatTranslatedActionPlan(
      [
        `Decide whether task #${opts.taskId} still represents real work. If it does, keep it and update it instead of deleting it.`,
        "If the task is stale or duplicate, use TaskCreate or TaskUpdate to make the real current work and next follow-up work visible before retrying deletion.",
        opts.retryStep,
      ],
      { taskListFirst: true }
    )
  )
}

interface GovernanceThresholds {
  minIncomplete: number
  minPending: number
}

export type TaskGovernanceMessageRequest =
  | {
      kind: "prior-session-tasks"
      toolName: string
      priorSessionId: string
      priorTaskCount: number
      taskLines: string
      completeExamples: string
    }
  | {
      kind: "no-tasks"
      toolName: string
      thresholds: GovernanceThresholds
    }
  | {
      kind: "all-tasks-completed"
      toolName: string
      thresholds: GovernanceThresholds
    }
  | {
      kind: "missing-task-minimums"
      toolName: string
      incompleteTaskList: string
    }
  | {
      kind: "too-many-in-progress"
      toolName: string
      inProgressCount: number
      cap: number
      taskList: string
    }
  | {
      kind: "direct-merge-intent"
      toolName: string
      taskList: string
    }
  | {
      kind: "stale-tasks"
      callsSinceLastTaskTool: number
      toolName: string
      taskList: string
      planSteps: ActionPlanItem[]
    }
  | {
      kind: "canonical-tasklist-stale"
      toolName: string
    }
  | {
      kind: "task-deletion-threshold"
      taskId: string
      toolName: string
    }
  | {
      kind: "pending-overflow"
      toolName: string
    }
  | {
      kind: "duplicate-subject-state"
      toolName: string
      groups: ReadonlyArray<DuplicateSubjectGroup>
    }
  | {
      kind: "duplicate-subject-create"
      subject: string
      collisionId: string
    }
  | {
      kind: "duplicate-subject-update"
      taskId: string
      groups: ReadonlyArray<DuplicateSubjectGroup>
    }
  | {
      kind: "reconciliation-required"
      toolName: string
    }
  | {
      kind: "completion-rate-limit"
      recentCompletionCount: number
      maxCompletions: number
      waitSeconds: number
    }
  | {
      kind: "native-deletion-threshold"
      taskId: string
    }
  | {
      kind: "completion-threshold"
      taskId: string
    }
  | {
      kind: "in-progress-transition-cap"
      taskId: string
      inProgressCount: number
      cap: number
      taskList: string
    }
  | {
      kind: "pending-completion-shortcut"
      taskId: string
    }
  | {
      kind: "phantom-completion"
      taskId: string
      sessionId?: string
    }
  | {
      kind: "tasklist-duplicate-subject-notice"
      groups: ReadonlyArray<DuplicateSubjectGroup>
    }

export function buildTaskGovernanceMessage(request: TaskGovernanceMessageRequest): string {
  switch (request.kind) {
    case "prior-session-tasks":
      return (
        `STOP. This session has no tasks, but a prior session (${request.priorSessionId}) had ${request.priorTaskCount} incomplete task(s):\n` +
        request.taskLines +
        `\n\n` +
        formatTranslatedActionPlan(
          [
            `If the work is already done, mark the prior tasks complete:\n${request.completeExamples}`,
            "If the work is still needed, use TaskCreate to re-create these tasks and mark the current one in_progress.",
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "no-tasks":
      return (
        `STOP. ${request.toolName} is BLOCKED. This session has no incomplete tasks.\n\n` +
        `Required:\n` +
        `  • At least ${request.thresholds.minIncomplete} incomplete tasks (pending/in_progress)\n` +
        `  • At least ${request.thresholds.minPending} pending task for the next intended step\n\n` +
        formatTranslatedActionPlan(
          [
            `If TaskList still shows no incomplete work, use TaskCreate to add at least ${request.thresholds.minIncomplete} tasks — one current-work task and at least one pending next step.`,
            "Include a concrete description of the current work and next step.",
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\nAfter task minimums are met, ${request.toolName} will be unblocked automatically.`
      )

    case "all-tasks-completed":
      return (
        `STOP. All session tasks are completed. ${request.toolName} is BLOCKED.\n\n` +
        `You have finished all planned work, but new tool calls require active tasks.\n\n` +
        formatTranslatedActionPlan(
          [
            `Use TaskCreate to add at least ${request.thresholds.minIncomplete} task(s) ` +
              `(including at least ${request.thresholds.minPending} pending) before continuing.`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "missing-task-minimums":
      return (
        `STOP. ${request.toolName} is BLOCKED. Prepare the task queue before more implementation.\n\n` +
        "Keep real current work and follow-up work visible.\n\n" +
        `${request.incompleteTaskList ? `Current incomplete tasks:\n${request.incompleteTaskList}\n\n` : ""}` +
        formatTranslatedActionPlan(
          [
            "Use TaskCreate or TaskUpdate to make the real current work and the next follow-up work visible.",
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "too-many-in-progress":
      return (
        `STOP. Too many in-progress tasks (${request.inProgressCount}/${request.cap} max). ${request.toolName} is BLOCKED.\n\n` +
        `Currently in progress:\n${request.taskList}\n\n` +
        `Having more than ${request.cap} simultaneous in_progress tasks weakens focus and planning quality.\n\n` +
        formatTranslatedActionPlan(
          [
            `Reduce in_progress count to ${request.cap} or fewer:`,
            [
              "Record completed tasks only when the work has evidence.",
              "Use TaskUpdate to move non-active tasks back to pending.",
            ],
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\nAfter reducing active tasks, ${request.toolName} will be unblocked automatically.`
      )

    case "direct-merge-intent":
      return (
        `STOP. ${request.toolName} is BLOCKED. The task plan includes "Merge PR" work while the workflow requires PR-based review.\n\n` +
        `Conflicting tasks:\n${request.taskList}\n\n` +
        `When strict-no-direct-main is enabled, all merges must go through the PR review workflow — direct merges are not permitted.\n\n` +
        formatTranslatedActionPlan(
          [
            'Use TaskUpdate to delete or rewrite the "Merge PR" task(s) — replace with PR-based steps (e.g. "Open PR", "Request review").',
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "stale-tasks":
      return (
        `STOP. Refresh tasks before continuing. ${plural(request.callsSinceLastTaskTool, "tool call")} since last task update. ` +
        `${request.toolName} is BLOCKED.\n\n` +
        `Current in-progress task context:\n${request.taskList}\n\n` +
        "Make the task list match the work before continuing.\n\n" +
        formatTranslatedActionPlan(request.planSteps) +
        `\nAfter TaskList and task updates are done, retry ${request.toolName}.`
      )

    case "canonical-tasklist-stale":
      return (
        `STOP. Run TaskList before ${request.toolName}.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "task-deletion-threshold":
      return buildDeletionGovernanceMessage({
        taskId: request.taskId,
        retryStep: retryAfterTaskList(request.toolName),
      })

    case "pending-overflow":
      return (
        `STOP. ${request.toolName} is BLOCKED.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "duplicate-subject-state":
      return (
        `STOP. ${request.toolName} is blocked until the duplicate task subjects are resolved.\n\n` +
        formatTranslatedActionPlan(
          [
            "Pick the duplicate entry that represents the real current work.",
            "Use TaskUpdate to rename the other duplicate, or cancel it if it is not real work.",
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(request.groups)}`
      )

    case "duplicate-subject-create":
      return (
        `STOP. Do not create another task named "${request.subject}".\n\n` +
        `Task #${request.collisionId} already covers that work.\n\n` +
        formatTranslatedActionPlan(
          [
            `Use TaskUpdate on #${request.collisionId} if that task needs a different status, subject, or description.`,
            "Use a different TaskCreate subject only if this is genuinely separate work.",
          ],
          { taskListFirst: true }
        )
      )

    case "duplicate-subject-update":
      return (
        `STOP. That TaskUpdate would leave task #${request.taskId} with a duplicate active subject.\n\n` +
        formatTranslatedActionPlan(
          [
            "Give one duplicate a unique subject that names distinct work.",
            "If one duplicate is stale, cancel it instead of keeping two active tasks with the same name.",
          ],
          { taskListFirst: true }
        ) +
        `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(request.groups)}`
      )

    case "reconciliation-required":
      return (
        `STOP. ${request.toolName} is blocked until task state is refreshed.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "completion-rate-limit":
      return (
        `Task completion rate limit: ${request.recentCompletionCount} completions in the last 5 seconds exceeds the threshold (max ${request.maxCompletions}).\n\n` +
        `Wait ${request.waitSeconds}s before completing another task.\n\n` +
        "Before retrying, you MUST:\n" +
        `1. ${TASKLIST_STABILITY_STEP}\n` +
        "2. Verify each task you intend to complete has concrete evidence (commit SHA, test output, file path)\n" +
        "3. Confirm the work described in the task subject has actually been done — not assumed, not deferred\n" +
        `4. ${TASKLIST_CONFIRM_STEP}\n` +
        "5. Complete ONE task at a time, waiting for this hook to clear between each\n\n" +
        "Rapid-fire completions bypass governance checks and risk leaving work unfinished."
      )

    case "native-deletion-threshold":
      return buildDeletionGovernanceMessage({
        taskId: request.taskId,
        retryStep:
          "Retry the deletion only after TaskList shows the task queue still represents real current and follow-up work.",
      })

    case "completion-threshold":
      return (
        `STOP. Cannot complete task #${request.taskId} yet.\n\n` +
        "Keep current and follow-up work visible before closing this task.\n\n" +
        formatTranslatedActionPlan(
          [
            "Use TaskCreate or TaskUpdate to make the real current work and next follow-up work visible before completing this task.",
            "Retry completion only after TaskList shows the planning buffer is healthy and the task has concrete evidence.",
          ],
          { taskListFirst: true }
        )
      )

    case "in-progress-transition-cap":
      return (
        `STOP. Cannot transition task #${request.taskId} to in_progress — too many active tasks.\n\n` +
        `Currently in progress (${request.inProgressCount}/${request.cap}):\n${request.taskList}\n\n` +
        `Maintaining focus requires keeping active work to a manageable level.\n\n` +
        formatTranslatedActionPlan(
          [
            "Resolve or park the in_progress tasks that are no longer active:",
            [
              "Record completed work only when it has evidence.",
              "Use TaskUpdate to move non-active tasks back to pending.",
            ],
            `Retry adopting task #${request.taskId} as active work only after TaskList shows focus has been restored.`,
          ],
          { taskListFirst: true }
        )
      )

    case "pending-completion-shortcut":
      return (
        `STOP. Task #${request.taskId} cannot be marked completed yet.\n\n` +
        "This looks like shortcut completion: the task is still only planned, and it appears to be closed before being actively started.\n\n" +
        "Move it to active status first, do the stated work, then close it with concrete evidence.\n\n" +
        formatTranslatedActionPlan(
          [
            TASKLIST_STABILITY_STEP,
            "Use the task tool to reflect the task you are genuinely working on now.",
            "Move this task to active status before making implementation or verification changes.",
            "Perform the implementation or verification work described by the task.",
            "Record completion only with concrete evidence such as commit:, file:, test:, or pr:.",
            TASKLIST_CONFIRM_STEP,
          ],
          { header: "Required next steps:" }
        )
      )

    case "phantom-completion": {
      const sessionNote = request.sessionId ? ` (session ${request.sessionId})` : ""
      return (
        `PHANTOM TASK BLOCK: Task #${request.taskId}${sessionNote} cannot be marked completed.\n\n` +
        `No substantive tool calls (Edit, Write, Bash, Read, Skill, Glob, Grep…) were\n` +
        `recorded after this task was adopted as active work. This looks like closure without work execution in progress.\n\n` +
        formatTranslatedActionPlan(
          [
            TASKLIST_STABILITY_STEP,
            "Use Edit, Write, Bash, or Skill to actually perform the work described in the task subject.",
            "Include traceable evidence in description: commit:<sha>, file:<path>, test:<result>, pr:<url>.",
            TASKLIST_CONFIRM_STEP,
          ],
          { header: "To resolve:" }
        )
      )
    }

    case "tasklist-duplicate-subject-notice":
      return (
        "TaskList found duplicate active task subjects. Resolve the task list before continuing.\n\n" +
        formatTranslatedActionPlan(
          [
            "Pick the duplicate entry that represents the real current work.",
            "Use TaskUpdate to give the other duplicate a unique subject, or cancel it if it is not real work.",
            `${TASKLIST_CONFIRM_STEP} Continue after each active subject appears once.`,
          ],
          { confirm: false }
        ) +
        `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(request.groups)}`
      )
  }
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
      return `Task update required in ${staleRemaining} tool call(s) - tools will be blocked until tasks are reviewed. We should run TaskList, refresh task state, and update tasks before the next implementation step.`
    }
    if (staleRemaining <= 4) {
      return `Task update due in ${staleRemaining} tool calls. We should run TaskList, record completed work only when it has evidence, refresh active work, or create new tasks for the work underway.`
    }
    return undefined
  }

  if (!isImplementationTool) return undefined

  const base =
    `Tasks need attention - it's been ${callsSinceTask} tool calls since the last task update. ` +
    "We should run TaskList, review progress from fresh state, record completed work only when it has evidence, update active work with current status, or create new tasks for the work underway."

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
    "Run TaskList before stopping.\n\n" +
    "This session used task tools but never called TaskList. " +
    `${TASKLIST_STABILITY_STEP} Then retry stop.`
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
      "No in_progress task. We should run TaskList first; if it still shows no active work, adopt one planned task before starting implementation."
    )
  } else if (counts.pending >= PLENTY_PENDING_THRESHOLD && counts.inProgress >= 1) {
    parts.push(
      "Good task hygiene: we have a planning buffer and one clear in_progress focus. Keep TaskList fresh, update status as work completes, and add pending tasks before the queue runs low."
    )
  }
}

export function formatIncompleteReason(taskDetails: string[]): string {
  if (taskDetails.length === 0) return ""

  const header = "Incomplete tasks remain in the current session:\n\n"
  const taskList = taskDetails.map((d) => `  - ${d}`).join("\n")
  const footer = `\n\nWe should complete these tasks before stopping. ${TASKLIST_STABILITY_STEP} Then update each task only when the work is done and the completion has evidence.`

  return header + taskList + footer
}

export const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Do not use the task management CLI from this session.\n\n" +
  "We should use native task tools only:\n" +
  "  - TaskCreate - new tasks\n" +
  "  - TaskUpdate - status, subject, description, and marking completed\n" +
  "  - TaskList / TaskGet - query tasks\n\n" +
  "Keep task work in the native task tools so the next step stays visible.\n\n" +
  "The only task management CLI subcommand still allowed here is `adopt` (orphan recovery after compaction)."

export function buildPendingCompletionTransitionMessage(taskId: string): string {
  return buildTaskGovernanceMessage({ kind: "pending-completion-shortcut", taskId })
}
