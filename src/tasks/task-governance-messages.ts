import { type ActionPlanItem, filterTaskListActionSteps, formatActionPlan } from "../action-plan.ts"
import {
  agentDefinitelySupportsTaskList,
  resolveTranslationAgent,
  taskToolNameForCurrentAgent,
} from "../agent-paths.ts"
import type { AgentDef } from "../agents.ts"
import { formatDuration } from "../format-duration.ts"
import { selectStableHookVariant } from "../hook-message-rephrasing.ts"
import type { PendingCompletionRefusal } from "./task-evidence.ts"
import { CANONICAL_TASKLIST_SYNC_MAX_AGE_MS } from "./task-governance-constants.ts"
import { replaceTaskGovernanceSynonyms } from "./task-governance-rephrasing.ts"
import type { PendingScopeCounts } from "./task-queue-view.ts"
import {
  type DuplicateSubjectGroup,
  formatDuplicateSubjectGroups,
} from "./task-subject-duplicates.ts"

let governanceTranslationAgent: AgentDef | null | undefined

function resolveGovernanceTranslationAgent(): AgentDef | null {
  if (governanceTranslationAgent !== undefined) {
    return governanceTranslationAgent
  }
  return resolveTranslationAgent()
}

export const TASKLIST_STABILITY_STEP = "Run TaskList now."

export const TASKLIST_CONFIRM_STEP = "Run TaskList again after updating tasks."

export const TASK_RECOVERY_HINT =
  "If these tasks are absent from the task tools, inspect the native session queues with `swiz tasks recover --all-sessions`. " +
  "For a stale or non-work task, use `swiz tasks recover status <task-id> cancelled --session <session-id> --evidence <reason>`. " +
  "Recovery requires an explicit session for changes and cannot create tasks."

function getOptionalTaskToolName(canonicalName: string): string | null {
  return taskToolNameForCurrentAgent(canonicalName)
}

export function getTaskToolName(canonicalName: string): string {
  return getOptionalTaskToolName(canonicalName) ?? canonicalName
}

function taskCreateToolName(): string {
  return getTaskToolName("TaskCreate")
}

function taskUpdateToolName(): string {
  return getTaskToolName("TaskUpdate")
}

function taskApproachMessage(): string {
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  const taskListName = getOptionalTaskToolName("TaskList")
  const taskGetName = getOptionalTaskToolName("TaskGet")
  const queryTaskNames =
    taskListName && taskGetName
      ? taskListName === taskGetName
        ? taskListName
        : `${taskListName} / ${taskGetName}`
      : (taskListName ?? taskGetName)
  const lines = [
    "Allowed approaches:",
    `  - ${taskCreateName} - add new tasks`,
    `  - ${taskUpdateName} - status, subject, description, and marking completed`,
    ...(queryTaskNames ? [`  - ${queryTaskNames} - query tasks`] : []),
  ]
  return replaceTaskGovernanceSynonyms(lines.join("\n"))
}

export interface TaskReviewInstructionContext {
  taskListAvailable?: boolean
  taskListToolName?: string | null
  taskUpdateToolName?: string | null
}

export function buildTaskReviewInstruction(options: TaskReviewInstructionContext = {}): string {
  const updateToolName = options.taskUpdateToolName ?? getOptionalTaskToolName("TaskUpdate")
  if (options.taskListAvailable === false) {
    if (!updateToolName) return "Update task statuses in the current planning surface."
    return `Use ${updateToolName} to update task statuses.`
  }

  const taskListToolName = options.taskListToolName ?? getOptionalTaskToolName("TaskList")
  if (!taskListToolName) {
    if (!updateToolName) return "Update task statuses in the current planning surface."
    return `Use ${updateToolName} to update task statuses.`
  }
  if (!updateToolName) return `Use ${taskListToolName} to review tasks.`
  if (taskListToolName === updateToolName) {
    return `Use ${updateToolName} to review tasks and update their status.`
  }

  return `Use ${taskListToolName} to review tasks, then ${updateToolName} to update their status.`
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
  const agent = resolveGovernanceTranslationAgent()
  const hasTaskList = agentDefinitelySupportsTaskList(agent)
  const prefixedSteps =
    options.taskListFirst && hasTaskList
      ? buildTaskListRepairPlan(steps, { confirm: options.confirm })
      : steps
  const actionSteps = filterTaskListActionSteps(prefixedSteps, hasTaskList)
  return formatActionPlan(actionSteps, {
    translateToolNames: true,
    agent,
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
      thresholds?: GovernanceThresholds
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
      /** Age of the last recorded sync; null when none is recorded. */
      lastSyncAgeMs: number | null
    }
  | {
      kind: "task-deletion-threshold"
      taskId: string
      toolName: string
    }
  | {
      kind: "pending-overflow"
      toolName: string
      pendingCount: number
      limit: number
      scope: PendingScopeCounts
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
      kind: "pending-completion-shortcut"
      taskId: string
      subject?: string
      reason: PendingCompletionRefusal
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

type Req<K extends TaskGovernanceMessageRequest["kind"]> = Extract<
  TaskGovernanceMessageRequest,
  { kind: K }
>

function buildNoTasksMessage(r: Req<"no-tasks">): string {
  const taskCreateName = taskCreateToolName()
  return (
    `${r.toolName} needs tasks in place first.\n\n` +
    `Add at least ${r.thresholds.minIncomplete} tasks (including ${r.thresholds.minPending} pending) to get started:\n\n` +
    formatTranslatedActionPlan(
      [
        `Use ${taskCreateName} to add at least ${r.thresholds.minIncomplete} tasks — one for the current work and at least one pending next step.`,
        "Include a concrete description of the current work and next step.",
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    ) +
    `\nOnce task minimums are met, ${r.toolName} will continue automatically.`
  )
}

function buildAllTasksCompletedMessage(r: Req<"all-tasks-completed">): string {
  const taskCreateName = taskCreateToolName()
  return (
    `All planned tasks are done — great work! Before continuing, add what comes next.\n\n` +
    `${r.toolName} needs at least ${r.thresholds.minIncomplete} active task(s) to proceed.\n\n` +
    formatTranslatedActionPlan(
      [
        `Use ${taskCreateName} to add at least ${r.thresholds.minIncomplete} task(s) ` +
          `(including at least ${r.thresholds.minPending} pending) before continuing.`,
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    )
  )
}

function buildMissingTaskMinimumsMessage(r: Req<"missing-task-minimums">): string {
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  const minPending = r.thresholds?.minPending ?? 1
  const pendingPrefix = minPending > 0 ? `${minPending} pending + ` : ""
  return (
    `Task queue needs at least ${pendingPrefix}1 in_progress before ${r.toolName} can continue.\n\n` +
    "Keep real current work and follow-up work visible.\n\n" +
    `${r.incompleteTaskList ? `Current incomplete tasks:\n${r.incompleteTaskList}\n\n` : ""}` +
    formatTranslatedActionPlan(
      [
        `Use ${taskCreateName} or ${taskUpdateName} to make the real current work and the next follow-up work visible.`,
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    )
  )
}

function buildTooManyInProgressMessage(r: Req<"too-many-in-progress">): string {
  const taskUpdateName = taskUpdateToolName()
  return (
    `Too many tasks active at once (${r.inProgressCount}/${r.cap} max) — ` +
    `bring it back to ${r.cap} in_progress before ${r.toolName} can continue.\n\n` +
    `Currently in progress:\n${r.taskList}\n\n` +
    `Keeping active work focused makes planning more effective.\n\n` +
    formatTranslatedActionPlan(
      [
        `Reduce in_progress count to ${r.cap} or fewer:`,
        [
          `Use ${taskUpdateName} to complete each task whose work is finished, with the evidence in the update.`,
          "Cancel a task only when it is stale, duplicated or no longer real work.",
          "Leave unfinished real work in_progress: it cannot move back to pending, and cancelling it would misrecord it. " +
            "If every listed task is unfinished real work, report that to the user instead of cancelling any of it.",
        ],
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    ) +
    `\nOnce active tasks are reduced, ${r.toolName} will continue automatically.`
  )
}

function buildDirectMergeIntentMessage(r: Req<"direct-merge-intent">): string {
  const taskUpdateName = taskUpdateToolName()
  return (
    `The task plan includes a direct merge, but this workflow routes merges through PR review.\n\n` +
    `Conflicting tasks:\n${r.taskList}\n\n` +
    `When strict-no-direct-main is enabled, all merges must go through the PR review workflow.\n\n` +
    formatTranslatedActionPlan(
      [
        `Use ${taskUpdateName} to delete or rewrite the "Merge PR" task(s) — replace with PR-based steps (e.g. "Open PR", "Request review").`,
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    )
  )
}

function buildStaleTasksMessage(r: Req<"stale-tasks">): string {
  return (
    `Tasks are ${plural(r.callsSinceLastTaskTool, "tool call")} behind — sync them before continuing with ${r.toolName}.\n\n` +
    `Current in-progress task context:\n${r.taskList}\n\n` +
    "Make the task list match the work before continuing.\n\n" +
    formatTranslatedActionPlan(r.planSteps) +
    `\nAfter TaskList and task updates are done, retry ${r.toolName}.`
  )
}

function buildCanonicalTasklistStaleMessage(r: Req<"canonical-tasklist-stale">): string {
  const windowMinutes = Math.round(CANONICAL_TASKLIST_SYNC_MAX_AGE_MS / 60_000)
  const lead = `Sync task state before ${r.toolName}.`
  const measured =
    r.lastSyncAgeMs === null
      ? "no canonical TaskList sync is recorded for this session"
      : `the last canonical TaskList sync for this session was ${formatDuration(r.lastSyncAgeMs)} ago`
  return (
    `${lead}\n\n` +
    `Cause: ${measured}; this gate needs one within the last ${windowMinutes} minutes. ` +
    "It checks sync age only, so changing the number of tasks does not clear it.\n\n" +
    formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(r.toolName)]) +
    `\nIf this block re-fires immediately after a TaskList call, the sync record is not being written — ` +
    `treat it as a hook fault and use the /re-assess skill instead of retrying.`
  )
}

function buildTaskDeletionThresholdMessage(r: Req<"task-deletion-threshold">): string {
  return buildDeletionGovernanceMessage({
    taskId: r.taskId,
    retryStep: retryAfterTaskList(r.toolName),
  })
}

function formatPendingScope(scope: PendingScopeCounts): string {
  const parts = [
    scope.thisSession ? `${scope.thisSession} in this session` : "",
    scope.projectQueue ? `${scope.projectQueue} in the shared project queue` : "",
    scope.otherSessions ? `${scope.otherSessions} owned by other sessions` : "",
  ].filter(Boolean)
  return parts.length ? `Counted: ${parts.join(", ")}. ` : ""
}

/**
 * Names the one predicate this gate evaluates (pending count against the limit), with its measured
 * values and scope, and only remedies that can lower that count without discarding real work. A
 * TaskList sync is offered to inspect the queue, never as the fix: it cannot change the count (#929).
 */
function buildPendingOverflowMessage(r: Req<"pending-overflow">): string {
  const taskUpdateName = taskUpdateToolName()
  return (
    `${r.toolName} is paused: ${r.pendingCount} pending tasks are queued, above the limit of ${r.limit}.\n\n` +
    formatPendingScope(r.scope) +
    `This gate counts pending tasks only and clears once ${r.limit} or fewer remain; a TaskList sync alone ` +
    "does not lower the count. It is relaxed briefly after a user message and while a skill runs, so a " +
    "retry can pass then without the count changing.\n\n" +
    formatTranslatedActionPlan(
      [
        `Bring pending down by ${r.pendingCount - r.limit} (to ${r.limit} or fewer):`,
        [
          `Use ${taskUpdateName} to complete pending tasks whose work is already done, with the evidence in the update's description.`,
          "Cancel only tasks that are stale, duplicated or no longer real work.",
          ...(r.scope.otherSessions
            ? ["Leave tasks owned by other sessions to their owners."]
            : []),
          "Do not cancel real planned work to satisfy this count; if every remaining task is real, report that to the user.",
        ],
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    )
  )
}

function buildDuplicateSubjectStateMessage(r: Req<"duplicate-subject-state">): string {
  const taskUpdateName = taskUpdateToolName()
  return (
    `Duplicate task subjects found — resolve them before ${r.toolName} can continue.\n\n` +
    formatTranslatedActionPlan(
      [
        "Pick the duplicate entry that represents the real current work.",
        `Use ${taskUpdateName} to rename the other duplicate, or cancel it if it is not real work.`,
        retryAfterTaskList(r.toolName),
      ],
      { taskListFirst: true }
    ) +
    `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(r.groups)}`
  )
}

function buildDuplicateSubjectCreateMessage(r: Req<"duplicate-subject-create">): string {
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  return (
    `Task #${r.collisionId} already covers "${r.subject}" — update that task instead of creating a duplicate.\n\n` +
    formatTranslatedActionPlan(
      [
        `Use ${taskUpdateName} on #${r.collisionId} if that task needs a different status, subject, or description.`,
        `Use a different ${taskCreateName} subject only if this is genuinely separate work.`,
      ],
      { taskListFirst: true }
    )
  )
}

function buildDuplicateSubjectUpdateMessage(r: Req<"duplicate-subject-update">): string {
  const taskUpdateName = taskUpdateToolName()
  return (
    `That ${taskUpdateName} would leave task #${r.taskId} with a duplicate active subject — rename one first.\n\n` +
    formatTranslatedActionPlan(
      [
        "Give one duplicate a unique subject that names distinct work.",
        "If one duplicate is stale, cancel it instead of keeping two active tasks with the same name.",
      ],
      { taskListFirst: true }
    ) +
    `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(r.groups)}`
  )
}

function buildReconciliationRequiredMessage(r: Req<"reconciliation-required">): string {
  return (
    `Refresh task state before ${r.toolName}.\n\n` +
    formatTranslatedActionPlan([TASKLIST_STABILITY_STEP, retryAfterTaskList(r.toolName)])
  )
}

function buildCompletionRateLimitMessage(r: Req<"completion-rate-limit">): string {
  return (
    `${completionRateLimitLead(r)}\n\n` +
    `Already closed ${r.recentCompletionCount} tasks in the last 5s; the limit is ${r.maxCompletions}. ` +
    `Wait ${r.waitSeconds}s, then close one task with concrete evidence.\n\n` +
    "Before retrying: run TaskList, confirm the target task has evidence " +
    "(commit:, test:, file:, or pr:), and update only that one task."
  )
}

function buildNativeDeletionThresholdMessage(r: Req<"native-deletion-threshold">): string {
  return buildDeletionGovernanceMessage({
    taskId: r.taskId,
    retryStep:
      "Retry the deletion only after TaskList shows the task queue still represents real current and follow-up work.",
  })
}

function buildCompletionThresholdMessage(r: Req<"completion-threshold">): string {
  const taskCreateName = taskCreateToolName()
  const taskUpdateName = taskUpdateToolName()
  return (
    `${completionThresholdLead(r.taskId)}\n\n` +
    "Keep both current work and the next follow-up visible before closing this task.\n\n" +
    formatTranslatedActionPlan(
      [
        `Use ${taskCreateName} or ${taskUpdateName} to show the real current work and next follow-up.`,
        "Retry only after TaskList shows a stable planning buffer and the task has concrete evidence.",
      ],
      { taskListFirst: true }
    )
  )
}

/**
 * Each refusal names only reachable steps: a pending task closes in one update when it carries its
 * evidence (that hop never takes an in_progress slot), otherwise it must be started first (#930).
 */
function buildPendingCompletionShortcutMessage(r: Req<"pending-completion-shortcut">): string {
  const taskUpdateName = taskUpdateToolName()
  const taskRef = r.subject ? `Task #${r.taskId} ("${r.subject}")` : `Task #${r.taskId}`
  if (r.reason === "missing-evidence") {
    return (
      `${taskRef} is still pending, and this update records no evidence of finished work.\n\n` +
      "Starting a task before closing it keeps the record honest; a pending task closes in one step " +
      "only when the completing update carries its evidence.\n\n" +
      formatTranslatedActionPlan(
        [
          TASKLIST_STABILITY_STEP,
          "If the work is not done yet, move this task to active status, do the work, then close it with evidence.",
          `If the work is already done, retry this ${taskUpdateName} with the evidence in its description ` +
            "(commit:, file:, test:, pr:, or note:). Completing a pending task this way does not take an in_progress slot.",
          TASKLIST_CONFIRM_STEP,
        ],
        { header: "Next steps:" }
      )
    )
  }
  return (
    `${taskRef} is still pending, and task auto-transition is disabled, so it must be active before it can close.\n\n` +
    "Starting a task before closing it keeps the record honest and makes it easier to track what was done.\n\n" +
    formatTranslatedActionPlan(
      [
        TASKLIST_STABILITY_STEP,
        "Move this task to active status, do the work, then close it with concrete evidence such as commit:, file:, test:, or pr:.",
        "If every in_progress slot is taken, first complete a finished in_progress task with evidence, " +
          "or cancel one that is stale, duplicated or no longer real work. Do not cancel real work to free a slot.",
        TASKLIST_CONFIRM_STEP,
      ],
      { header: "Next steps:" }
    )
  )
}

function buildPhantomCompletionMessage(r: Req<"phantom-completion">): string {
  const sessionNote = r.sessionId ? ` (session ${r.sessionId})` : ""
  return (
    `Task #${r.taskId}${sessionNote} needs substantive work before it can close.\n\n` +
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

function buildTasklistDuplicateSubjectNoticeMessage(
  r: Req<"tasklist-duplicate-subject-notice">
): string {
  const taskUpdateName = taskUpdateToolName()
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
    `\n\nDuplicates to fix:\n${formatDuplicateSubjectGroups(r.groups)}`
  )
}

const MESSAGE_BUILDERS: {
  [K in TaskGovernanceMessageRequest["kind"]]: (r: Req<K>) => string
} = {
  "no-tasks": buildNoTasksMessage,
  "all-tasks-completed": buildAllTasksCompletedMessage,
  "missing-task-minimums": buildMissingTaskMinimumsMessage,
  "too-many-in-progress": buildTooManyInProgressMessage,
  "direct-merge-intent": buildDirectMergeIntentMessage,
  "stale-tasks": buildStaleTasksMessage,
  "canonical-tasklist-stale": buildCanonicalTasklistStaleMessage,
  "task-deletion-threshold": buildTaskDeletionThresholdMessage,
  "pending-overflow": buildPendingOverflowMessage,
  "duplicate-subject-state": buildDuplicateSubjectStateMessage,
  "duplicate-subject-create": buildDuplicateSubjectCreateMessage,
  "duplicate-subject-update": buildDuplicateSubjectUpdateMessage,
  "reconciliation-required": buildReconciliationRequiredMessage,
  "completion-rate-limit": buildCompletionRateLimitMessage,
  "native-deletion-threshold": buildNativeDeletionThresholdMessage,
  "completion-threshold": buildCompletionThresholdMessage,
  "pending-completion-shortcut": buildPendingCompletionShortcutMessage,
  "phantom-completion": buildPhantomCompletionMessage,
  "tasklist-duplicate-subject-notice": buildTasklistDuplicateSubjectNoticeMessage,
}

export function buildTaskGovernanceMessage(
  request: TaskGovernanceMessageRequest,
  options?: { translationAgent?: AgentDef | null }
): string {
  const saved = governanceTranslationAgent
  if (options && "translationAgent" in options) {
    governanceTranslationAgent = options.translationAgent
  }
  try {
    return (MESSAGE_BUILDERS[request.kind] as (r: TaskGovernanceMessageRequest) => string)(request)
  } finally {
    governanceTranslationAgent = saved
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
      return taskVoiceVariant(
        `preview:pending-completion-shortcut:${request.taskId}`,
        request.reason === "missing-evidence"
          ? [
              "Task closure paused: record the evidence, or start the pending item first.",
              "Pending task cannot close without evidence of finished work.",
              "Task update blocked: a one-step close needs its evidence.",
              "Close a pending task only with evidence of the finished work.",
            ]
          : [
              "Task closure paused: start the pending item before closing it.",
              "Pending task cannot close directly while auto-transition is off.",
              "Task update blocked: pending work needs an active step first.",
              "Start the planned task before recording it as complete.",
            ]
      )
    default:
      return null
  }
}

export function buildTaskDivergenceMessage(snapshot: {
  complete: boolean
  weightedSum: number
  callsSinceMovement: number
  lastMovementAt: string | null
  lastMovementKind: "task-create" | "task-update" | null
  advisoryThreshold: number
  steerThreshold: number
}): string | undefined {
  if (!snapshot.complete || !snapshot.lastMovementAt || !snapshot.lastMovementKind) return undefined
  if (snapshot.weightedSum < Math.min(snapshot.advisoryThreshold, snapshot.steerThreshold))
    return undefined
  const movement = getTaskToolName(
    snapshot.lastMovementKind === "task-create" ? "TaskCreate" : "TaskUpdate"
  )
  const level =
    snapshot.weightedSum >= snapshot.steerThreshold
      ? "Task divergence steer"
      : "Task divergence advisory"
  return (
    `${level}: ${snapshot.weightedSum} weighted calls across ${snapshot.callsSinceMovement} governed calls since ` +
    `${movement} changed task state at ${snapshot.lastMovementAt}. ` +
    `Use ${getTaskToolName("TaskUpdate")} or ${getTaskToolName("TaskCreate")} to record what actually changed in the work. ` +
    "Task reads and unchanged updates do not reset this signal. This is advisory only."
  )
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
  const summary = formatTaskStateLead(counts)
  return counts.issueHints?.length && counts.pending < 2
    ? `${summary} Potential follow-up issues: ${counts.issueHints.join("; ")}.`
    : summary
}

/** Queue depth is factual context, never evidence that the work has drifted. */
export function formatTaskStateLead(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
}): string {
  return `Tasks: ${counts.inProgress} in_progress, ${counts.pending} pending, ${counts.incomplete} incomplete (${counts.total} total).`
}

export function formatIncompleteReason(
  taskDetails: string[],
  sourceCtx?: { tasksDir: string | null; sessionId: string } & TaskReviewInstructionContext
): string {
  if (taskDetails.length === 0) return ""

  const header = "Incomplete tasks remain in the current session:\n\n"
  const taskList = taskDetails.map((d) => `  - ${d}`).join("\n")
  const sourceNote = sourceCtx
    ? `\n\nTask files: ${sourceCtx.tasksDir ?? `~/.claude/tasks/${sourceCtx.sessionId}`}`
    : ""
  const footer = sourceCtx
    ? `\n\nComplete these tasks before stopping. ${buildTaskReviewInstruction(sourceCtx)} Only mark tasks completed when the work is done and the completion has evidence.`
    : `\n\nComplete these tasks before stopping. ${TASKLIST_STABILITY_STEP} Then update each task only when the work is done and the completion has evidence.`

  return `${header}${taskList}${sourceNote}${footer}\n\n${TASK_RECOVERY_HINT}`
}

export const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Use the native task tools here instead of the swiz tasks CLI.\n\n" +
  `${TASK_APPROACH_MESSAGE}\n\n` +
  "Use task tools for routine work, including listing recovered tasks.\n\n" +
  "Keep task state in the native task flow so planning stays accurate and auditable.\n\n" +
  TASK_RECOVERY_HINT

// `buildLastTaskStandingDenial` and its suggestion helpers lived here. They were already
// unreachable — no caller since handleTaskCompletion took over completion governance — and #834
// made their premise wrong as well: the copy asserted "The task list must never be fully
// complete", which is exactly the rule that turned into a ratchet and got demoted to advisory.
// Removed rather than left dormant, so nobody rewires a denial the policy no longer wants.
