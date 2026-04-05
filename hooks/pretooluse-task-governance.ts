#!/usr/bin/env bun
// Consolidated task governance PreToolUse hooks.
//
// Contains 4 hook objects covering:
//   1. TaskUpdate schema validation — blocks unsupported fields
//   2. Task subject validation — denies compound task subjects
//   3. Task requirement enforcement — blocks Edit/Write/Bash without proper tasks
//   4. TaskUpdate completion governance — blocks swiz CLI, rate-limits completions
//
// Each hook is exported as a named export for manifest registration.
// Original files are thin wrappers for standalone subprocess execution.

import { formatDuration } from "../src/format-duration.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import type { RunSwizHookAsMainOptions, SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import { needsReconciliation, overlayEventState } from "../src/tasks/task-event-state.ts"
import {
  findPriorSessionTasks,
  formatNativeTaskCompleteCommands,
  formatTaskList,
  formatTaskSubjectsForDisplay,
  isIncompleteTaskStatus,
  readSessionTasks,
  readSessionTasksFresh,
} from "../src/tasks/task-recovery.ts"
import { isGitWorkingTreeClean, validateLastTaskStanding } from "../src/tasks/task-service.ts"
import { detect, formatMessage } from "../src/tasks/task-subject-validation.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import {
  buildLastTaskStandingDenial,
  formatActionPlan,
  getCurrentSessionTaskToolStats,
  hasFileInTree,
  isCurrentAgent,
  isEditTool,
  isGitRepo,
  isRunningInAgent,
  isShellTool,
  isTaskListTool,
  isTaskTrackingExemptShellCommand,
  isTerminalTaskStatus,
  isWriteTool,
  mergeActionPlanIntoTasks,
  preToolUseAllow,
  preToolUseAllowWithContext,
  preToolUseDeny,
  resolveSafeSessionId,
  scheduleAutoSteer,
} from "../src/utils/hook-utils.ts"
import { shellTokenCommandRe, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"
import { TASK_UPDATE_ALLOWED_FIELDS, toolHookInputSchema } from "./schemas.ts"

// ─── Shared governance infrastructure ──────────────────────────────────────

interface GovernanceThresholds {
  minIncomplete: number
  minPending: number
}

const GOVERNANCE_THRESHOLDS = {
  strict: { minIncomplete: 2, minPending: 1 },
  relaxed: { minIncomplete: 1, minPending: 0 },
  "local-dev": { minIncomplete: 1, minPending: 0 },
} as const

function resolveGovernanceThresholds(auditStrictness: string): GovernanceThresholds {
  const mode = auditStrictness as keyof typeof GOVERNANCE_THRESHOLDS
  return GOVERNANCE_THRESHOLDS[mode] ?? GOVERNANCE_THRESHOLDS.strict
}

// ═══════════════════════════════════════════════════════════════════════════
// § 1. TaskUpdate Schema Validation
// ═══════════════════════════════════════════════════════════════════════════

export const taskupdateSchemaHook: SwizToolHook = {
  name: "pretooluse-taskupdate-schema",
  event: "preToolUse",
  matcher: "TaskUpdate|update_plan",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

    const unsupported = Object.keys(toolInput).filter((k) => !TASK_UPDATE_ALLOWED_FIELDS.has(k))
    if (unsupported.length > 0) {
      const allowed = [...TASK_UPDATE_ALLOWED_FIELDS].join(", ")
      const reason =
        `TaskUpdate received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
        `Allowed fields: ${allowed}.`
      return preToolUseDeny(reason)
    }

    return {}
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// § 2. Task Subject Validation
// ═══════════════════════════════════════════════════════════════════════════

export const taskSubjectValidationHook: SwizToolHook = {
  name: "pretooluse-task-subject-validation",
  event: "preToolUse",
  matcher: "TaskCreate|TodoWrite",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolInput = input.tool_input as Record<string, any> | undefined
    const subject: string = (toolInput?.subject as string) ?? ""

    const result = detect(subject)
    if (result.matched) {
      return preToolUseDeny(formatMessage(result))
    }

    return preToolUseAllow()
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// § 3. Task Requirement Enforcement (Edit/Write/Bash)
// ═══════════════════════════════════════════════════════════════════════════

async function denyAutoSteerOrBlock(
  sessionId: string,
  cwd: string | undefined,
  reason: string
): Promise<SwizHookOutput> {
  if (sessionId) {
    if (await scheduleAutoSteer(sessionId, reason, undefined, cwd)) {
      return preToolUseAllow("")
    }
  }
  return preToolUseDeny(reason)
}

const STALENESS_THRESHOLD = 20
const LARGE_CONTENT_LINE_THRESHOLD = 10
const IN_PROGRESS_CAP = 4

const MEMORY_MARKDOWN_RE = /\.(md|json)$/i

/**
 * Heuristic patterns that indicate intent to merge directly to the default branch,
 * which contradicts the strict-no-direct-main PR-based workflow.
 */
export const DIRECT_MERGE_INTENT_RE =
  /\bmerge\s+pr\b|\bmerge\s+(?:to|into)\s+(?:main|master)\b|\brebase\s+and\s+merge\b|\bmerge\s+branch\s+(?:to|into)\s+(?:main|master)\b|\bsquash\s+and\s+merge\b|\bmerge\s+directly\b/i

/**
 * Detect whether an Edit/Write payload carries substantial content (10+ lines).
 * Blocking a large payload throws away expensive work — better to let it through
 * and rely on post-tool advisory for stale-task guidance.
 */
export function isLargeContentPayload(input: Record<string, any>): boolean {
  const toolInput = input?.tool_input as Record<string, any> | undefined
  const content = ((toolInput?.new_string ?? toolInput?.content) as string) ?? ""
  return content.split("\n").length >= LARGE_CONTENT_LINE_THRESHOLD
}

async function isTaskEnforcementProject(cwd: string): Promise<boolean> {
  if (!(await isGitRepo(cwd))) return false
  return await hasFileInTree(cwd, "CLAUDE.md")
}

function isBlockedTool(toolName: string): boolean {
  return isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName)
}

function isMemoryMarkdownEdit(input: Record<string, any>, toolName: string): boolean {
  if (!isEditTool(toolName) && !isWriteTool(toolName)) return false
  const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
  return MEMORY_MARKDOWN_RE.test(filePath)
}

function buildIncompleteTaskSummary(
  allTasks: Array<{ id: string; status: string; subject: string }>
): {
  incompleteTasks: Array<{ id: string; status: string; subject: string }>
  pendingTasks: Array<{ id: string; status: string; subject: string }>
  allTasksDone: boolean
  incompleteTaskList: string
} {
  const incompleteTasks = allTasks.filter((task) => isIncompleteTaskStatus(task.status))
  const pendingTasks = incompleteTasks.filter((task) => task.status === "pending")
  const allTasksDone =
    allTasks.length > 0 && allTasks.every((task) => isTerminalTaskStatus(task.status))
  const incompleteTaskList = incompleteTasks
    .map((task) => `  • #${task.id} (${task.status}): ${task.subject}`)
    .join("\n")

  return { incompleteTasks, pendingTasks, allTasksDone, incompleteTaskList }
}

function buildSlowTaskWarning(
  allTasks: Array<{
    id: string
    status: string
    subject: string
    startedAt?: number | null
    statusChangedAt?: string
    elapsedMs?: number
  }>,
  thresholdMinutes: number
): string | null {
  const thresholdMs = thresholdMinutes * 60_000
  const warnings = allTasks
    .filter((task) => task.status === "in_progress")
    .map((task) => {
      const durationMs = getTaskCurrentDurationMs(task)
      if (durationMs <= thresholdMs) return null
      return (
        `Task #${task.id} has been in_progress for ${formatDuration(durationMs)} ` +
        `(${task.subject}) — consider backgrounding or switching approach.`
      )
    })
    .filter((warning): warning is string => Boolean(warning))

  if (warnings.length === 0) return null
  return warnings.join("\n")
}

function checkNoTasks(
  toolName: string,
  cwd: string,
  sessionId: string,
  thresholds: GovernanceThresholds
): (
  allTasks: Array<{ id: string; status: string; subject: string }>
) => Promise<SwizHookOutput | undefined> {
  return async (allTasks) => {
    if (allTasks.length !== 0) return undefined
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const taskLines = formatTaskList(priorTasks)
      const completeExamples = formatNativeTaskCompleteCommands(
        priorTasks,
        priorSessionId,
        "note:completed in prior session",
        { indent: "  " }
      )
      return preToolUseDeny(
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

    return preToolUseDeny(
      `STOP. ${toolName} is BLOCKED because this session has no incomplete tasks.\n\n` +
        `Required:\n` +
        `  • At least ${thresholds.minIncomplete} incomplete tasks (pending/in_progress)\n` +
        `  • At least ${thresholds.minPending} pending task for the next intended step\n\n` +
        formatActionPlan(
          [
            `Use TaskCreate to add at least ${thresholds.minIncomplete} tasks — one in_progress for current work and at least one pending for the next step.`,
            "Include a concrete description of the current work and next step.",
          ],
          { translateToolNames: true }
        ) +
        `\n` +
        `After task minimums are met, ${toolName} will be unblocked automatically.`
    )
  }
}

function checkTaskMinimums(
  toolName: string,
  summary: ReturnType<typeof buildIncompleteTaskSummary>,
  thresholds: GovernanceThresholds
): SwizHookOutput | undefined {
  const { incompleteTasks, pendingTasks, allTasksDone, incompleteTaskList } = summary
  if (allTasksDone) return undefined
  if (
    incompleteTasks.length >= thresholds.minIncomplete &&
    pendingTasks.length >= thresholds.minPending
  )
    return undefined

  const missingIncomplete = Math.max(0, thresholds.minIncomplete - incompleteTasks.length)
  const missingPending = Math.max(0, thresholds.minPending - pendingTasks.length)
  const actions: string[] = []

  if (missingIncomplete > 0 && missingPending > 0) {
    actions.push(
      `Use TaskCreate to add ${missingIncomplete} incomplete task(s) (including at least ${missingPending} pending task(s)).`
    )
  } else if (missingPending > 0) {
    actions.push(
      `Use TaskCreate to add ${missingPending} pending task(s) for the next intended step.`
    )
  } else if (missingIncomplete > 0) {
    actions.push(`Use TaskCreate to add ${missingIncomplete} incomplete task(s).`)
  }

  return preToolUseDeny(
    `STOP. ${toolName} is BLOCKED because the required tasks are missing.\n\n` +
      `Current:\n` +
      `  • Incomplete tasks: ${incompleteTasks.length}\n` +
      `  • Pending tasks: ${pendingTasks.length}\n` +
      `${incompleteTaskList ? `\nCurrent incomplete tasks:\n${incompleteTaskList}\n` : "\n"}` +
      formatActionPlan(
        [...actions, `Retry this ${toolName} call after the missing task(s) have been created.`],
        { translateToolNames: true }
      )
  )
}

async function checkInProgressCap(
  toolName: string,
  sessionId: string,
  cwd: string | undefined,
  allTasks: Array<{ id: string; status: string; subject: string }>
): Promise<SwizHookOutput | undefined> {
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress")
  if (inProgressTasks.length <= IN_PROGRESS_CAP) return undefined
  const taskList = inProgressTasks.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  return await denyAutoSteerOrBlock(
    sessionId,
    cwd,
    `STOP. Too many in-progress tasks (${inProgressTasks.length}/${IN_PROGRESS_CAP} max). ${toolName} is BLOCKED.\n\n` +
      `Currently in progress:\n${taskList}\n\n` +
      `Having more than ${IN_PROGRESS_CAP} simultaneous in_progress tasks weakens focus and planning quality.\n\n` +
      formatActionPlan(
        [
          `Reduce in_progress count to ${IN_PROGRESS_CAP} or fewer:`,
          [
            "Use TaskUpdate to mark completed tasks done (status: completed).",
            "Use TaskUpdate to move non-active tasks back to pending.",
          ],
          `Retry ${toolName} — it will succeed once in_progress count is within the cap.`,
        ],
        { translateToolNames: true }
      ) +
      `\n` +
      `After reducing active tasks, ${toolName} will be unblocked automatically.`
  )
}

async function checkDirectMergeIntent(
  toolName: string,
  sessionId: string,
  cwd: string | undefined,
  incompleteTasks: Array<{ id: string; status: string; subject: string }>
): Promise<SwizHookOutput | undefined> {
  const mergePrTasks = incompleteTasks.filter((t) => DIRECT_MERGE_INTENT_RE.test(t.subject))
  if (mergePrTasks.length === 0) return undefined
  try {
    const settings = await readSwizSettings()
    if (!settings.strictNoDirectMain) return undefined
    const taskList = mergePrTasks.map((t) => `  • #${t.id} (${t.status}): ${t.subject}`).join("\n")
    return await denyAutoSteerOrBlock(
      sessionId,
      cwd,
      `STOP. ${toolName} is BLOCKED because strict-no-direct-main is enabled but the task plan includes "Merge PR" tasks.\n\n` +
        `Conflicting tasks:\n${taskList}\n\n` +
        `When strict-no-direct-main is enabled, all merges must go through the PR review workflow — ` +
        `direct merges are not permitted.\n\n` +
        formatActionPlan(
          [
            'Use TaskUpdate to delete or rewrite the "Merge PR" task(s) — replace with PR-based steps (e.g. "Open PR", "Request review").',
            `Retry this ${toolName} call after the task plan no longer contains merge-to-main intent.`,
          ],
          { translateToolNames: true }
        )
    )
  } catch {
    return undefined
  }
}

interface CheckTaskStalenessOpts {
  toolName: string
  input: Record<string, any>
  transcriptPath: string
  allTasks: Array<{ id: string; status: string; subject: string }>
  activeTasks: string[]
  allTasksDone: boolean
  cwd: string
  sessionId: string
}

function shouldSkipStalenessCheck(opts: {
  transcriptPath: string
  lastTaskIndex: number
  allTasksDone: boolean
  callsSinceTask: number
  toolName: string
  input: Record<string, any>
  hasInProgressTask: boolean
}): boolean {
  if (!opts.transcriptPath) return true
  if (opts.lastTaskIndex < 0 || opts.allTasksDone) return true
  if (opts.callsSinceTask < STALENESS_THRESHOLD) return true
  if (opts.hasInProgressTask) return true
  return (
    (isEditTool(opts.toolName) || isWriteTool(opts.toolName)) && isLargeContentPayload(opts.input)
  )
}

async function checkTaskStaleness(
  opts: CheckTaskStalenessOpts
): Promise<SwizHookOutput | undefined> {
  const { toolName, input, transcriptPath, allTasks, activeTasks, allTasksDone, cwd, sessionId } =
    opts
  const { lastTaskToolCallIndex, callsSinceLastTaskTool } =
    await getCurrentSessionTaskToolStats(input)

  const hasInProgressTask = allTasks.some((t) => t.status === "in_progress")
  if (
    shouldSkipStalenessCheck({
      transcriptPath,
      lastTaskIndex: lastTaskToolCallIndex,
      allTasksDone,
      callsSinceTask: callsSinceLastTaskTool,
      toolName,
      input,
      hasInProgressTask,
    })
  )
    return undefined

  const taskList = formatTaskSubjectsForDisplay(allTasks, activeTasks)
  const projectState = await readProjectState(cwd).catch(() => null)
  const stateStep = projectState
    ? `Check project state (\`swiz state show\`): currently \`${projectState}\`. Run \`swiz state set <state>\` if the work phase has changed.`
    : `Set a project state to reflect the current phase: \`swiz state set <state>\` (\`swiz state list\` for options).`
  const stalePlanSteps: (string | string[])[] = [
    "Update existing tasks to reflect current reality:",
    [
      "Use TaskUpdate to update in-progress tasks with the latest progress.",
      "Mark completed work done.",
      "Ensure the current work has an in_progress task with a clear description.",
    ],
    "Use TaskCreate to create at least one further task for the next concrete step based on the work underway.",
    stateStep,
  ]
  const sid = (input as Record<string, any>).session_id as string | undefined
  if (sid) await mergeActionPlanIntoTasks(stalePlanSteps, sid, cwd)
  return await denyAutoSteerOrBlock(
    sessionId,
    cwd,
    `STOP. Tasks have gone stale. ${callsSinceLastTaskTool} tool calls since last task update. ` +
      `${toolName} is BLOCKED.\n\n` +
      `We currently have these tasks in progress:\n${taskList}\n\n` +
      `However, it's been a while since we've updated the task list. Good task hygiene means the list should stay fully reflective of what we're currently doing.\n\n` +
      `Tasks are not suggestions - they are our execution plan. Stale tasks mean we are operating without clear accountability.\n\n` +
      `Our current work has clearly grown in scope beyond the original task definition. We should update the in-progress task with current status, and create a new task that represents the work now underway.\n\n` +
      formatActionPlan(stalePlanSteps, { translateToolNames: true }) +
      `\n` +
      `After updating tasks, ${toolName} will be unblocked automatically.`
  )
}

interface SlowTaskEntry {
  id: string
  status: string
  subject: string
  startedAt?: number | null
  statusChangedAt?: string
  elapsedMs?: number
}

async function emitSlowTaskWarning(
  allTasks: SlowTaskEntry[],
  sessionId: string,
  cwd: string
): Promise<SwizHookOutput | undefined> {
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effectiveSettings = getEffectiveSwizSettings(settings, sessionId, projectSettings)
    const slowTaskWarning = buildSlowTaskWarning(
      allTasks,
      effectiveSettings.taskDurationWarningMinutes
    )
    if (slowTaskWarning) {
      return preToolUseAllowWithContext(slowTaskWarning, slowTaskWarning)
    }
  } catch {
    // Settings lookup failures should never block or crash the tool call.
  }
  return undefined
}

interface ParsedInput {
  input: Record<string, any>
  toolName: string
  sessionId: string
  transcriptPath: string
  cwd: string
}

function isExemptToolCall(input: Record<string, any>, toolName: string): boolean {
  if (isShellTool(toolName)) {
    const toolInput = input?.tool_input as Record<string, any> | undefined
    const command = String(toolInput?.command ?? "")
    if (isTaskTrackingExemptShellCommand(command)) return true
  }
  return isMemoryMarkdownEdit(input, toolName)
}

function validateGuardConditions(
  sessionId: string | null | undefined,
  toolName: string,
  input: Record<string, any>
): boolean {
  if (!sessionId || !isBlockedTool(toolName) || !getHomeDirOrNull()) return false
  if (isCurrentAgent("gemini")) return false
  return !isExemptToolCall(input, toolName)
}

function applySyncGuards(input: Record<string, any>): ParsedInput | null {
  const toolName: string = (input?.tool_name as string) ?? ""
  const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
  const transcriptPath: string = (input?.transcript_path as string) ?? ""
  const cwd: string = (input?.cwd as string) ?? process.cwd()

  if (!validateGuardConditions(sessionId, toolName, input)) return null

  return { input, toolName, sessionId: sessionId as string, transcriptPath, cwd }
}

async function tryParseAndGuard(input: Record<string, any>): Promise<ParsedInput | null> {
  const parsed = applySyncGuards(input)
  if (!parsed) return null
  if (!(await isTaskEnforcementProject(parsed.cwd))) return null
  return parsed
}

interface TaskDeletionContext {
  taskBeingDeleted: { id: string; status: string; subject: string } | undefined
  taskId: string
  toolName: string
  incompleteTasks: Array<{ id: string; status: string; subject: string }>
  pendingTasks: Array<{ id: string; status: string; subject: string }>
  thresholds: GovernanceThresholds
}

function checkTaskDeletionGovernance(ctx: TaskDeletionContext): SwizHookOutput | undefined {
  if (!ctx.taskBeingDeleted || !isIncompleteTaskStatus(ctx.taskBeingDeleted.status)) {
    return undefined
  }

  const incompleteAfterDelete = ctx.incompleteTasks.length - 1
  const isPendingTask = ctx.taskBeingDeleted.status === "pending"
  const pendingAfterDelete = isPendingTask ? ctx.pendingTasks.length - 1 : ctx.pendingTasks.length

  if (
    incompleteAfterDelete >= ctx.thresholds.minIncomplete &&
    pendingAfterDelete >= ctx.thresholds.minPending
  ) {
    return undefined
  }

  return preToolUseDeny(
    `STOP. Cannot delete task #${ctx.taskId} — it would violate governance thresholds.\n\n` +
      `After deletion:\n` +
      `  • Incomplete tasks: ${incompleteAfterDelete}/${ctx.thresholds.minIncomplete} (required)\n` +
      `  • Pending tasks: ${pendingAfterDelete}/${ctx.thresholds.minPending} (required)\n\n` +
      `Tasks enforce planning discipline. Before deleting a task, create replacement tasks to maintain the required planning buffer.\n\n` +
      formatActionPlan(
        [
          `Use TaskCreate to add ${Math.max(0, ctx.thresholds.minIncomplete - incompleteAfterDelete)} incomplete task(s) ` +
            `(including ${Math.max(0, ctx.thresholds.minPending - pendingAfterDelete)} pending).`,
          `Retry this ${ctx.toolName} call after the required tasks have been created.`,
        ],
        { translateToolNames: true }
      )
  )
}

function checkTaskDeletion(
  toolName: string,
  allTasks: Array<{ id: string; status: string; subject: string }>,
  thresholds: GovernanceThresholds,
  input: Record<string, any>
): SwizHookOutput | undefined {
  if (toolName !== "TaskUpdate") return undefined
  const toolInput = input?.tool_input as Record<string, any> | undefined
  if (toolInput?.status !== "deleted") return undefined

  const taskId = String(toolInput?.taskId ?? "")
  if (!taskId) return undefined

  const incompleteTasks = allTasks.filter((t) => isIncompleteTaskStatus(t.status))
  const pendingTasks = incompleteTasks.filter((t) => t.status === "pending")
  const taskBeingDeleted = allTasks.find((t) => t.id === taskId)

  return checkTaskDeletionGovernance({
    taskBeingDeleted,
    taskId,
    toolName,
    incompleteTasks,
    pendingTasks,
    thresholds,
  })
}

async function runRequireTasksChecks(parsed: ParsedInput): Promise<SwizHookOutput> {
  const { input, toolName, sessionId, transcriptPath, cwd } = parsed

  let thresholds: GovernanceThresholds = GOVERNANCE_THRESHOLDS.strict
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effectiveSettings = getEffectiveSwizSettings(settings, sessionId, projectSettings)
    thresholds = resolveGovernanceThresholds(effectiveSettings.auditStrictness)
  } catch {
    // Settings read failure → use strict thresholds as default
  }

  const allTasks = overlayEventState(await readSessionTasksFresh(sessionId), sessionId)
  const activeTasks = allTasks
    .filter((t) => isIncompleteTaskStatus(t.status))
    .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

  if (needsReconciliation(sessionId) && isBlockedTool(toolName) && !isTaskListTool(toolName)) {
    return preToolUseDeny(
      "An invalid task state transition was detected (e.g. pending → completed). " +
        "Call TaskList now to reconcile task state before continuing."
    )
  }

  const deletionOutcome = checkTaskDeletion(toolName, allTasks, thresholds, input)
  if (deletionOutcome) return deletionOutcome

  const noTasksOutcome = await checkNoTasks(toolName, cwd, sessionId, thresholds)(allTasks)
  if (noTasksOutcome) return noTasksOutcome

  const summary = buildIncompleteTaskSummary(allTasks)
  const minOutcome = checkTaskMinimums(toolName, summary, thresholds)
  if (minOutcome) return minOutcome

  const capOutcome = await checkInProgressCap(toolName, sessionId, cwd, allTasks)
  if (capOutcome) return capOutcome

  const mergeOutcome = await checkDirectMergeIntent(
    toolName,
    sessionId,
    cwd,
    summary.incompleteTasks
  )
  if (mergeOutcome) return mergeOutcome

  const staleOutcome = await checkTaskStaleness({
    toolName,
    input,
    transcriptPath,
    allTasks,
    activeTasks,
    allTasksDone: summary.allTasksDone,
    cwd,
    sessionId,
  })
  if (staleOutcome) return staleOutcome

  const slowOutcome = await emitSlowTaskWarning(allTasks, sessionId, cwd)
  if (slowOutcome) return slowOutcome

  return {}
}

function unexpectedHookFailureOutput(err: unknown): SwizHookOutput {
  const message = err instanceof Error ? err.message : String(err)
  return preToolUseDeny(
    `STOP. \u26a0\ufe0f pretooluse-require-tasks encountered an unexpected error and is failing closed.\n\n` +
      `Error: ${message}\n\n` +
      formatActionPlan(
        [
          "Check that the hook file and its dependencies are intact.",
          "If the error persists, inspect the hook source at hooks/pretooluse-task-governance.ts.",
        ],
        { translateToolNames: true }
      )
  )
}

export async function evaluatePretooluseRequireTasks(
  input: Record<string, any>
): Promise<SwizHookOutput> {
  const parsed = await tryParseAndGuard(input)
  if (!parsed) return {}
  return await runRequireTasksChecks(parsed)
}

export const requireTasksHook: SwizToolHook = {
  name: "pretooluse-require-tasks",
  event: "preToolUse",
  matcher: "Edit|Write|Bash",
  timeout: 5,

  async run(input) {
    try {
      return await evaluatePretooluseRequireTasks(input as Record<string, any>)
    } catch (err: unknown) {
      return unexpectedHookFailureOutput(err)
    }
  },
}

export const requireTasksRunAsMainOptions: RunSwizHookAsMainOptions = {
  onStdinJsonError: unexpectedHookFailureOutput,
}

// ═══════════════════════════════════════════════════════════════════════════
// § 4. TaskUpdate Completion Governance (CLI enforcement + rate limiting)
// ═══════════════════════════════════════════════════════════════════════════

const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"

const SWIZ_TASKS_CLI_RE = shellTokenCommandRe(String.raw`swiz\s+tasks(?:\s|$)`)
const SWIZ_TASKS_ADOPT_RE = shellTokenCommandRe(String.raw`swiz\s+tasks\s+adopt(?:\s|$)`)

const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Do not use the `swiz tasks` CLI inside Claude Code.\n\n" +
  "Use native task tools only:\n" +
  "  • TaskCreate — new tasks\n" +
  "  • TaskUpdate — status, subject, description, and marking completed\n" +
  "  • TaskList / TaskGet — query tasks\n\n" +
  "Work must stay in the tracked tool channel (auditing, hooks, and task sync depend on it).\n\n" +
  "The only `swiz tasks` subcommand still allowed here is `adopt` (orphan recovery after compaction)."

function shouldInspectShellInput(input: { tool_name?: string }): boolean {
  return isClaudeCode && isShellTool(input?.tool_name ?? "")
}

function isBlockedSwizTasksCliCommand(command: string): boolean {
  const stripped = stripQuotedShellStrings(command)
  if (!SWIZ_TASKS_CLI_RE.test(stripped)) return false
  return !SWIZ_TASKS_ADOPT_RE.test(stripped)
}

async function denyIfLastTaskStanding(
  taskId: string,
  sessionId: string,
  cwd?: string
): Promise<SwizHookOutput | null> {
  const allTasks = await readSessionTasks(sessionId)
  const repoClean = isGitWorkingTreeClean(cwd)
  const error = validateLastTaskStanding(taskId, allTasks, { repoClean })
  if (error) {
    return preToolUseDeny(await buildLastTaskStandingDenial(taskId, cwd))
  }
  return null
}

// ─── Sliding-window completion rate limiter ─────────────────────────────────

const WINDOW_MS = 5_000
const MAX_COMPLETIONS_IN_WINDOW = 2

const completionTimestamps = new Map<string, number[]>()

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS
  return timestamps.filter((t) => t > cutoff)
}

function checkCompletionRateLimit(sessionId: string): SwizHookOutput | null {
  const now = Date.now()
  const existing = completionTimestamps.get(sessionId) ?? []
  const recent = pruneWindow(existing, now)

  if (recent.length >= MAX_COMPLETIONS_IN_WINDOW) {
    completionTimestamps.set(sessionId, recent)
    const oldestInWindow = recent[0] ?? now
    const waitSec = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000)
    return preToolUseDeny(
      `Task completion rate limit: ${recent.length} completions in the last 5 seconds exceeds the threshold (max ${MAX_COMPLETIONS_IN_WINDOW}).\n\n` +
        `Wait ${waitSec}s before completing another task.\n\n` +
        "Before retrying, you MUST:\n" +
        "1. Run TaskList to review the current task state\n" +
        "2. Verify each task you intend to complete has concrete evidence (commit SHA, test output, file path)\n" +
        "3. Confirm the work described in the task subject has actually been done — not assumed, not deferred\n" +
        "4. Complete ONE task at a time, waiting for this hook to clear between each\n\n" +
        "Rapid-fire completions bypass governance checks and risk leaving work unfinished."
    )
  }

  recent.push(now)
  completionTimestamps.set(sessionId, recent)
  return null
}

async function checkNativeTaskDeletionGovernance(
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      cwd ? readProjectSettings(cwd).catch(() => null) : Promise.resolve(null),
    ])
    const allTasks = await readSessionTasks(sessionId)
    const effectiveSettings = getEffectiveSwizSettings(
      settings,
      sessionId,
      projectSettings ?? undefined
    )
    const thresholds = resolveGovernanceThresholds(effectiveSettings.auditStrictness)

    const incompleteTasks = allTasks.filter((t) => isIncompleteTaskStatus(t.status))
    const pendingTasks = incompleteTasks.filter((t) => t.status === "pending")
    const taskBeingDeleted = allTasks.find((t) => t.id === taskId)

    if (taskBeingDeleted && isIncompleteTaskStatus(taskBeingDeleted.status)) {
      const incompleteAfterDelete = incompleteTasks.length - 1
      const isPendingTask = taskBeingDeleted.status === "pending"
      const pendingAfterDelete = isPendingTask ? pendingTasks.length - 1 : pendingTasks.length

      if (
        incompleteAfterDelete < thresholds.minIncomplete ||
        pendingAfterDelete < thresholds.minPending
      ) {
        return preToolUseDeny(
          `STOP. Cannot delete task #${taskId} — it would violate governance thresholds.\n\n` +
            `After deletion:\n` +
            `  • Incomplete tasks: ${incompleteAfterDelete}/${thresholds.minIncomplete} (required)\n` +
            `  • Pending tasks: ${pendingAfterDelete}/${thresholds.minPending} (required)\n\n` +
            `Tasks enforce planning discipline. Before deleting a task, create replacement tasks to maintain the required planning buffer.\n\n` +
            `Use TaskCreate to add ${Math.max(0, thresholds.minIncomplete - incompleteAfterDelete)} incomplete task(s) ` +
            `(including ${Math.max(0, thresholds.minPending - pendingAfterDelete)} pending), then retry the deletion.`
        )
      }
    }
  } catch {
    return null
  }
  return null
}

async function handleTaskDeletionCompletion(
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  return await checkNativeTaskDeletionGovernance(taskId, sessionId, cwd)
}

async function handleTaskCompletion(
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  const rateLimited = checkCompletionRateLimit(sessionId)
  if (rateLimited) return rateLimited
  return await denyIfLastTaskStanding(taskId, sessionId, cwd)
}

type NativeTaskUpdateResult = SwizHookOutput | "early_exit" | "continue"

async function checkNativeTaskUpdateCompletion(
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return "early_exit"

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return "early_exit"

  const cwd = (input.cwd as string) ?? undefined

  if (toolInput.status === "deleted") {
    const deletionDenied = await handleTaskDeletionCompletion(taskId, sessionId, cwd)
    if (deletionDenied) return deletionDenied
    return "continue"
  }

  if (toolInput.status !== "completed") return "early_exit"

  // Reject pending → completed: must transition through in_progress first.
  // This prevents the "validation lag" gap where an illegal state is written
  // but subsequent tools are blocked by the reconciliation gate.
  const allTasks = await readSessionTasks(sessionId)
  const currentTask = allTasks.find((t) => t.id === taskId)
  if (currentTask && currentTask.status === "pending") {
    return preToolUseDeny(
      `Cannot complete task #${taskId} directly from pending.\n\n` +
        `Required transition: pending → in_progress → completed.\n\n` +
        `Use TaskUpdate to set task #${taskId} to in_progress first, then complete it.`
    )
  }

  const completionDenied = await handleTaskCompletion(taskId, sessionId, cwd)
  if (completionDenied) return completionDenied
  return "continue"
}

async function runSwizTasksEnforcement(input: Record<string, any>): Promise<SwizHookOutput> {
  const command = String((input.tool_input as Record<string, any> | undefined)?.command ?? "")
  const sessionId = String(input.session_id ?? "")
  const cwd = (input.cwd as string) ?? undefined

  if (!isBlockedSwizTasksCliCommand(command)) {
    return preToolUseAllow("")
  }

  if (
    sessionId &&
    (await scheduleAutoSteer(sessionId, SWIZ_TASKS_CLI_DENY_MESSAGE, undefined, cwd))
  ) {
    return preToolUseAllow(SWIZ_TASKS_CLI_DENY_MESSAGE)
  }
  return preToolUseDeny(SWIZ_TASKS_CLI_DENY_MESSAGE)
}

function isNativeTaskTool(toolName: string): boolean {
  return toolName === "TaskUpdate" || toolName === "update_plan"
}

export async function evaluatePretooluseEnforceTaskupdate(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const rec = parsed as unknown as Record<string, any>
  const toolName = String(rec.tool_name ?? "")

  if (isNativeTaskTool(toolName)) {
    const n = await checkNativeTaskUpdateCompletion(rec)
    if (n === "early_exit") return {}
    if (n !== "continue") return n
  }

  if (!shouldInspectShellInput(parsed)) return {}

  return await runSwizTasksEnforcement(rec)
}

export const enforceTaskupdateHook: SwizToolHook = {
  name: "pretooluse-enforce-taskupdate",
  event: "preToolUse",
  timeout: 5,

  run(input) {
    return evaluatePretooluseEnforceTaskupdate(input)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// § 5. Merged Task Governance — single entry point for all preToolUse
// ═══════════════════════════════════════════════════════════════════════════

async function evaluatePretooluseTaskGovernance(rawInput: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(rawInput)
  const input = parsed as unknown as Record<string, any>
  const toolName = String(input.tool_name ?? "")
  const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

  // ── TaskUpdate / update_plan path ──────────────────────────────────────
  if (isNativeTaskTool(toolName)) {
    // Schema validation (sync, cheap)
    const unsupported = Object.keys(toolInput).filter((k) => !TASK_UPDATE_ALLOWED_FIELDS.has(k))
    if (unsupported.length > 0) {
      const allowed = [...TASK_UPDATE_ALLOWED_FIELDS].join(", ")
      return preToolUseDeny(
        `TaskUpdate received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
          `Allowed fields: ${allowed}.`
      )
    }

    // Completion / deletion / rate-limit governance
    const n = await checkNativeTaskUpdateCompletion(input)
    if (n === "early_exit") return {}
    if (n !== "continue") return n

    // CLI enforcement for shell-based task commands
    if (shouldInspectShellInput(parsed)) {
      return await runSwizTasksEnforcement(input)
    }
    return {}
  }

  // ── TaskCreate / TodoWrite path ────────────────────────────────────────
  if (toolName === "TaskCreate" || toolName === "TodoWrite") {
    const subject: string = (toolInput?.subject as string) ?? ""
    const result = detect(subject)
    if (result.matched) {
      return preToolUseDeny(formatMessage(result))
    }
    return preToolUseAllow()
  }

  // ── Edit / Write / Bash path (blocked tools) ──────────────────────────
  if (isBlockedTool(toolName)) {
    // Guard conditions: only enforce in git repos with CLAUDE.md, not gemini
    const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
    const cwd: string = (input.cwd as string) ?? process.cwd()

    if (!validateGuardConditions(sessionId, toolName, input)) return {}
    if (!(await isTaskEnforcementProject(cwd))) return {}

    const transcriptPath: string = (input.transcript_path as string) ?? ""

    // CLI enforcement runs first for shell tools (catches `swiz tasks` misuse)
    if (shouldInspectShellInput(parsed)) {
      const cliResult = await runSwizTasksEnforcement(input)
      if (cliResult && Object.keys(cliResult).length > 0) {
        const hso = (cliResult as Record<string, any>).hookSpecificOutput as
          | Record<string, any>
          | undefined
        if (hso?.permissionDecision === "deny") return cliResult
      }
    }

    // Full task requirement checks
    return await runRequireTasksChecks({
      input,
      toolName,
      sessionId: sessionId as string,
      transcriptPath,
      cwd,
    })
  }

  // ── Other shell tools (not blocked, but check CLI enforcement) ─────────
  if (shouldInspectShellInput(parsed)) {
    return await runSwizTasksEnforcement(input)
  }

  return {}
}

const pretooluseTaskGovernance: SwizToolHook = {
  name: "pretooluse-task-governance",
  event: "preToolUse",
  timeout: 5,

  async run(input) {
    try {
      return await evaluatePretooluseTaskGovernance(input)
    } catch (err: unknown) {
      return unexpectedHookFailureOutput(err)
    }
  },
}

export default pretooluseTaskGovernance
