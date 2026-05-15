import { type ActionPlanItem, formatActionPlan } from "../action-plan.ts"
import { detectCurrentAgentFromEnv, toolNameForCurrentAgent } from "../agent-paths.ts"
import { selectStableHookVariant } from "../hook-message-rephrasing.ts"
import { replaceTaskGovernanceSynonyms } from "./task-governance-rephrasing.ts"
import {
  type DuplicateSubjectGroup,
  formatDuplicateSubjectGroups,
} from "./task-subject-duplicates.ts"

const PLENTY_PENDING_THRESHOLD = 2

export const TASKLIST_STABILITY_STEP = "Run TaskList now."

export const TASKLIST_CONFIRM_STEP = "Run TaskList again after updating tasks."

function resolveCodexTaskAlias(canonicalName: string): string {
  const agent = detectCurrentAgentFromEnv()
  if (agent?.id === "codex" && (canonicalName === "TaskCreate" || canonicalName === "TaskUpdate")) {
    return "update_plan"
  }
  return toolNameForCurrentAgent(canonicalName)
}

export function getTaskToolName(canonicalName: string): string {
  return resolveCodexTaskAlias(canonicalName)
}

function taskCreateToolName(): string {
  return resolveCodexTaskAlias("TaskCreate")
}

function taskUpdateToolName(): string {
  return resolveCodexTaskAlias("TaskUpdate")
}

function taskApproachMessage(): string {
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  return replaceTaskGovernanceSynonyms(
    "Allowed approaches:\n" +
      `  - ${taskCreateName} - add new tasks\n` +
      `  - ${taskUpdateName} - status, subject, description, and marking completed\n` +
      `  - ${toolNameForCurrentAgent("TaskList")} / ${toolNameForCurrentAgent("TaskGet")} - query tasks`
  )
}

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
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  return (
    `Task #${opts.taskId} needs a replacement before it can be removed.\n\n` +
    "Keep current work and follow-up work visible before removing this task.\n\n" +
    formatTranslatedActionPlan(
      [
        `Decide whether task #${opts.taskId} still represents real work. If it does, update it instead of deleting it.`,
        `If the task is stale or duplicate, use ${taskCreateName} or ${taskUpdateName} to make the real current work and next follow-up work visible before retrying deletion.`,
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
      sessionId?: string
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
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  switch (request.kind) {
    case "prior-session-tasks":
      return (
        `Prior incomplete tasks found from session ${request.priorSessionId} (${request.priorTaskCount} task(s)):\n` +
        request.taskLines +
        `\n\n` +
        formatTranslatedActionPlan(
          [
            `If the work is already done, mark the prior tasks complete:\n${request.completeExamples}`,
            `If the work is still needed, use ${taskCreateName} to re-create these tasks and mark the current one in_progress.`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "no-tasks":
      return (
        `${request.toolName} needs tasks in place first.\n\n` +
        `Add at least ${request.thresholds.minIncomplete} tasks (including ${request.thresholds.minPending} pending) to get started:\n\n` +
        formatTranslatedActionPlan(
          [
            `Use ${taskCreateName} to add at least ${request.thresholds.minIncomplete} tasks — one for the current work and at least one pending next step.`,
            "Include a concrete description of the current work and next step.",
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\nOnce task minimums are met, ${request.toolName} will continue automatically.`
      )

    case "all-tasks-completed":
      return (
        `All planned tasks are done — great work! Before continuing, add what comes next.\n\n` +
        `${request.toolName} needs at least ${request.thresholds.minIncomplete} active task(s) to proceed.\n\n` +
        formatTranslatedActionPlan(
          [
            `Use ${taskCreateName} to add at least ${request.thresholds.minIncomplete} task(s) ` +
              `(including at least ${request.thresholds.minPending} pending) before continuing.`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "missing-task-minimums":
      return (
        `Task queue needs at least 1 pending + 1 in_progress before ${request.toolName} can continue.\n\n` +
        "Keep real current work and follow-up work visible.\n\n" +
        `${request.incompleteTaskList ? `Current incomplete tasks:\n${request.incompleteTaskList}\n\n` : ""}` +
        formatTranslatedActionPlan(
          [
            `Use ${taskCreateName} or ${taskUpdateName} to make the real current work and the next follow-up work visible.`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "too-many-in-progress":
      return (
        `Too many tasks active at once (${request.inProgressCount}/${request.cap} max) — ` +
        `bring it back to ${request.cap} in_progress before ${request.toolName} can continue.\n\n` +
        `Currently in progress:\n${request.taskList}\n\n` +
        `Keeping active work focused makes planning more effective.\n\n` +
        formatTranslatedActionPlan(
          [
            `Reduce in_progress count to ${request.cap} or fewer:`,
            [
              "Record completed tasks only when the work has evidence.",
              `Use ${taskUpdateName} to move non-active tasks back to pending.`,
            ],
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\nOnce active tasks are reduced, ${request.toolName} will continue automatically.`
      )

    case "direct-merge-intent":
      return (
        `The task plan includes a direct merge, but this workflow routes merges through PR review.\n\n` +
        `Conflicting tasks:\n${request.taskList}\n\n` +
        `When strict-no-direct-main is enabled, all merges must go through the PR review workflow.\n\n` +
        formatTranslatedActionPlan(
          [
            `Use ${taskUpdateName} to delete or rewrite the "Merge PR" task(s) — replace with PR-based steps (e.g. "Open PR", "Request review").`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        )
      )

    case "stale-tasks":
      return (
        `Tasks are ${plural(request.callsSinceLastTaskTool, "tool call")} behind — sync them before continuing with ${request.toolName}.\n\n` +
        `Current in-progress task context:\n${request.taskList}\n\n` +
        "Make the task list match the work before continuing.\n\n" +
        formatTranslatedActionPlan(request.planSteps) +
        `\nAfter TaskList and task updates are done, retry ${request.toolName}.`
      )

    case "canonical-tasklist-stale":
      return (
        `Run TaskList to sync task state before ${request.toolName}.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "task-deletion-threshold":
      return buildDeletionGovernanceMessage({
        taskId: request.taskId,
        retryStep: retryAfterTaskList(request.toolName),
      })

    case "pending-overflow":
      return (
        `Run TaskList to clear the task state, then retry ${request.toolName}.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "duplicate-subject-state":
      return (
        `Duplicate task subjects found — resolve them before ${request.toolName} can continue.\n\n` +
        formatTranslatedActionPlan(
          [
            "Pick the duplicate entry that represents the real current work.",
            `Use ${taskUpdateName} to rename the other duplicate, or cancel it if it is not real work.`,
            retryAfterTaskList(request.toolName),
          ],
          { taskListFirst: true }
        ) +
        `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(request.groups)}`
      )

    case "duplicate-subject-create":
      return (
        `Task #${request.collisionId} already covers "${request.subject}" — update that task instead of creating a duplicate.\n\n` +
        formatTranslatedActionPlan(
          [
            `Use ${taskUpdateName} on #${request.collisionId} if that task needs a different status, subject, or description.`,
            `Use a different ${taskCreateName} subject only if this is genuinely separate work.`,
          ],
          { taskListFirst: true }
        )
      )

    case "duplicate-subject-update":
      return (
        `That ${taskUpdateName} would leave task #${request.taskId} with a duplicate active subject — rename one first.\n\n` +
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
        `Run TaskList to refresh task state before ${request.toolName}.\n\n` +
        formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(request.toolName)])
      )

    case "completion-rate-limit":
      return (
        `${completionRateLimitLead(request)}\n\n` +
        `Already closed ${request.recentCompletionCount} tasks in the last 5s; the limit is ${request.maxCompletions}. ` +
        `Wait ${request.waitSeconds}s, then close one task with concrete evidence.\n\n` +
        "Before retrying: run TaskList, confirm the target task has evidence " +
        "(commit:, test:, file:, or pr:), and update only that one task."
      )

    case "native-deletion-threshold":
      return buildDeletionGovernanceMessage({
        taskId: request.taskId,
        retryStep:
          "Retry the deletion only after TaskList shows the task queue still represents real current and follow-up work.",
      })

    case "completion-threshold":
      return (
        `${completionThresholdLead(request.taskId)}\n\n` +
        "Keep both current work and the next follow-up visible before closing this task.\n\n" +
        formatTranslatedActionPlan(
          [
            `Use ${taskCreateName} or ${taskUpdateName} to show the real current work and next follow-up.`,
            "Retry only after TaskList shows a stable planning buffer and the task has concrete evidence.",
          ],
          { taskListFirst: true }
        )
      )

    case "in-progress-transition-cap":
      return (
        `Task #${request.taskId} can't go active yet — ${request.inProgressCount} of ${request.cap} in_progress slots are already taken.\n\n` +
        `Currently in progress:\n${request.taskList}\n\n` +
        `Focusing on one thing at a time makes it easier to track progress.\n\n` +
        formatTranslatedActionPlan(
          [
            "Resolve or park the in_progress tasks that are no longer active:",
            [
              "Record completed work only when it has evidence.",
              `Use ${taskUpdateName} to move non-active tasks back to pending.`,
            ],
            `Retry adopting task #${request.taskId} as active work only after TaskList shows focus has been restored.`,
          ],
          { taskListFirst: true }
        )
      )

    case "pending-completion-shortcut":
      return (
        `Task #${request.taskId} is still pending — set it in_progress first, do the work, then close it with evidence.\n\n` +
        "Starting a task before closing it keeps the record honest and makes it easier to track what was done.\n\n" +
        formatTranslatedActionPlan(
          [
            TASKLIST_STABILITY_STEP,
            `Use ${taskUpdateName} to reflect the task you are genuinely working on now.`,
            "Move this task to active status before making implementation or verification changes.",
            "Perform the implementation or verification work described by the task.",
            "Record completion only with concrete evidence such as commit:, file:, test:, or pr:.",
            TASKLIST_CONFIRM_STEP,
          ],
          { header: "Next steps:" }
        )
      )

    case "phantom-completion": {
      const sessionNote = request.sessionId ? ` (session ${request.sessionId})` : ""
      return (
        `Task #${request.taskId}${sessionNote} needs substantive work before it can close.\n\n` +
        `No Edit, Write, Bash, Read, Skill, Glob, or Grep calls were recorded after this task went active — ` +
        `do the work, then close it.\n\n` +
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
        "TaskList found duplicate active task subjects — resolve them before continuing.\n\n" +
        formatTranslatedActionPlan(
          [
            "Pick the duplicate entry that represents the real current work.",
            `Use ${taskUpdateName} to give the other duplicate a unique subject, or cancel it if it is not real work.`,
            `${TASKLIST_CONFIRM_STEP} Continue after each active subject appears once.`,
          ],
          { confirm: false }
        ) +
        `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(request.groups)}`
      )
  }
}

function taskVoiceVariant(key: string, variants: readonly string[]): string {
  return selectStableHookVariant(key, variants)
}

function completionRateLimitLead(request: {
  recentCompletionCount: number
  maxCompletions: number
  waitSeconds: number
  sessionId?: string
}): string {
  const key = [
    "completion-rate-limit",
    request.sessionId ?? "session",
    request.recentCompletionCount,
    request.maxCompletions,
  ].join(":")
  return taskVoiceVariant(key, [
    "Task closure cadence is too tight.",
    "Completion throttle is active.",
    "Pause the close-out loop.",
    "Task updates are arriving too quickly.",
    "Slow the task completion pace.",
  ])
}

function completionThresholdLead(taskId: string): string {
  return taskVoiceVariant(`completion-threshold:${taskId}`, [
    `Keep a follow-up task visible before closing #${taskId}.`,
    `Task #${taskId} cannot close until the queue still shows what comes next.`,
    `The queue would lose its next step if #${taskId} closes now.`,
    `Task #${taskId} needs visible current and follow-up work before closure.`,
  ])
}

export function buildTaskGovernancePreview(request: TaskGovernanceMessageRequest): string | null {
  switch (request.kind) {
    case "completion-rate-limit":
      return taskVoiceVariant(`preview:completion-rate-limit:${request.sessionId ?? "session"}`, [
        "Task closure paused: wait, then complete one item with evidence.",
        "Completion throttle active: slow down and retry one task only.",
        "Pause task closure: the repair path is in the details.",
        "Task updates are too rapid: verify evidence before retrying.",
      ])
    case "completion-threshold":
      return taskVoiceVariant(`preview:completion-threshold:${request.taskId}`, [
        "Task closure paused until the queue shows what comes next.",
        "Queue state needs repair before this task can close.",
        "Keep current and follow-up work visible before retrying.",
        "Task update blocked: preserve the planning buffer first.",
      ])
    case "pending-completion-shortcut":
      return taskVoiceVariant(`preview:pending-completion-shortcut:${request.taskId}`, [
        "Task closure paused: start the pending item before closing it.",
        "Pending task cannot close directly; make the work visible first.",
        "Task update blocked: pending work needs an active step first.",
        "Start the planned task before recording it as complete.",
      ])
    default:
      return null
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
    return `Create tasks now (${remaining} tool call remaining) — ${taskCreateName} required before the next step is blocked.`
  }
  if (remaining <= 3) {
    return `Plan the next tasks soon — ${taskCreateName} required in ${remaining} tool calls to avoid interruption.`
  }
  if (total >= 2) {
    return `${total}/${threshold} tool calls in — consider creating tasks now before the work expands further.`
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
      return `Task update due in ${staleRemaining} tool call(s) — run TaskList, refresh task state, and update tasks before the next implementation step.`
    }
    if (staleRemaining <= 4) {
      return `Task update due in ${staleRemaining} tool calls — run TaskList, record completed work only when it has evidence, refresh active work, or create new tasks for the work underway.`
    }
    return undefined
  }

  if (!isImplementationTool) return undefined

  const base =
    `Tasks are ${callsSinceTask} tool calls behind — ` +
    "run TaskList, record completed work only when it has evidence, update active work with current status, or create new tasks for the work underway."

  if (callsSinceTask <= 20) return base

  return `${base} The task list is now well behind the work — pause implementation and sync it before continuing with ${toolName}.`
}

export function buildUserPromptTaskContext(pendingCount: number, taskCreateName: string): string {
  if (pendingCount === 0) {
    return `No pending tasks in this session. Use ${taskCreateName} to create a task for this prompt before starting work.`
  }
  return `Use ${taskCreateName} to create a task for this prompt before starting work on it.`
}

export function buildTaskListBeforeStopMessage(): string {
  return (
    "Run TaskList before stopping.\n\n" +
    "This session used task tools but never called TaskList. " +
    `${TASKLIST_STABILITY_STEP} Then retry stop.`
  )
}

const TASK_APPROACH_MESSAGE = taskApproachMessage()

export const SWIZ_TASKS_FILES_DENY_MESSAGE =
  "Task files in `.claude/tasks` are managed automatically — use the task tools instead.\n\n" +
  `${TASK_APPROACH_MESSAGE}\n\n` +
  "Avoid editing `.claude/tasks/**` files directly with Edit, Write, or Bash.\n" +
  "Use the native task tools to keep task state accurate and auditable."

export function buildCountSummary(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
  issueHints?: string[]
}): string {
  const parts: string[] = [formatTaskStateLead(counts)]
  appendPlanningFeedback(parts, counts)
  appendHygieneFeedback(parts, counts)
  return parts.join(" ")
}

export function formatTaskStateLead(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
}): string {
  if (counts.total === 0 || counts.incomplete === 0) return "Task queue empty."
  if (counts.inProgress === 0) return "No active task yet."
  if (counts.pending === 0) return "Planning buffer empty."
  if (counts.pending === 1 && counts.incomplete <= 2) return "Planning buffer thin."
  if (counts.pending >= PLENTY_PENDING_THRESHOLD && counts.inProgress >= 1) {
    return "Task buffer healthy."
  }
  return "Task state needs attention."
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
      "Add two pending tasks before continuing: one for the next step in the current work, and one broader follow-on."
    )
  } else if (counts.pending === 1 && counts.incomplete <= 2) {
    parts.push(
      "Add another pending task to keep the buffer stable. Prefer one immediate next step and one broader follow-on task."
    )
  }

  if (
    (counts.pending === 0 || (counts.pending === 1 && counts.incomplete <= 2)) &&
    counts.issueHints &&
    counts.issueHints.length > 0
  ) {
    parts.push(`Potential follow-up issues: ${counts.issueHints.join("; ")}.`)
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
      "Run TaskList, then use TaskUpdate to claim one pending task before starting implementation."
    )
  } else if (counts.pending >= PLENTY_PENDING_THRESHOLD && counts.inProgress >= 1) {
    parts.push(
      "Good task hygiene: planning buffer in place; keep statuses current as work changes."
    )
  }
}

export function formatIncompleteReason(taskDetails: string[]): string {
  if (taskDetails.length === 0) return ""

  const header = "Incomplete tasks remain in the current session:\n\n"
  const taskList = taskDetails.map((d) => `  - ${d}`).join("\n")
  const footer = `\n\nComplete these tasks before stopping. ${TASKLIST_STABILITY_STEP} Then update each task only when the work is done and the completion has evidence.`

  return header + taskList + footer
}

export const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Use the native task tools here instead of the swiz tasks CLI.\n\n" +
  `${TASK_APPROACH_MESSAGE}\n\n` +
  "Avoid `swiz tasks <subcommand>` for all subcommands except `swiz tasks adopt` (including `--recovered`).\n\n" +
  "Keep task state in the native task flow so planning stays accurate and auditable."

export function buildPendingCompletionTransitionMessage(taskId: string): string {
  return buildTaskGovernanceMessage({ kind: "pending-completion-shortcut", taskId })
}
