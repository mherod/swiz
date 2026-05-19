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

import { agentHasTaskToolsForHookPayload } from "../src/agent-paths.ts"
import { formatDuration } from "../src/format-duration.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import type { RunSwizHookAsMainOptions, SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import {
  hookSpecificOutputSchema,
  TASK_UPDATE_ALLOWED_FIELDS,
  toolHookInputSchema,
} from "../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import {
  hasHealthyPendingTaskBuffer,
  hasHealthyTaskBuffer,
} from "../src/tasks/task-buffer-health.ts"
import {
  isBlockedSwizTaskFilesCommand,
  isBlockedSwizTasksCliCommand,
  isBlockedTaskFilePath,
  SWIZ_TASKS_CLI_DENY_MESSAGE,
} from "../src/tasks/task-cli-governance.ts"
import {
  applyTaskUpdateEvent,
  needsReconciliation,
  overlayEventState,
} from "../src/tasks/task-event-state.ts"
import {
  buildTaskGovernanceMessage,
  buildTaskGovernancePreview,
  formatTaskStateLead,
  getTaskToolName,
  SWIZ_TASKS_FILES_DENY_MESSAGE,
  TASKLIST_CONFIRM_STEP,
  TASKLIST_STABILITY_STEP,
  type TaskGovernanceMessageRequest,
} from "../src/tasks/task-governance-messages.ts"
import { replaceTaskGovernanceSynonyms } from "../src/tasks/task-governance-rephrasing.ts"
import { fetchIssueHints } from "../src/tasks/task-issue-hints.ts"
import {
  applyCacheTaskUpdate,
  findPriorSessionTasks,
  formatNativeTaskCompleteCommands,
  formatTaskList,
  formatTaskSubjectsForDisplay,
  isIncompleteTaskStatus,
  readSessionTasks,
  readSessionTasksFresh,
} from "../src/tasks/task-recovery.ts"
// validateLastTaskStanding removed — handleTaskCompletion now checks full governance thresholds
import {
  CANONICAL_TASKLIST_SYNC_MAX_AGE_MS,
  readCanonicalTaskListSyncAtMs,
} from "../src/tasks/task-state-cache.ts"
import { isTaskSubjectWorkDeferral } from "../src/tasks/task-subject-deferral.ts"
import {
  applyTaskUpdatePreview,
  duplicateSubjectSeverity,
  findDuplicateSubjectCollision,
  findDuplicateSubjectGroups,
  type TaskSubjectEntry,
  taskIdIsInDuplicateGroups,
} from "../src/tasks/task-subject-duplicates.ts"
import { detect, formatMessage } from "../src/tasks/task-subject-validation.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import {
  detectCurrentAgentFromEnv,
  formatActionPlan,
  getCurrentSessionTaskToolStats,
  hasFileInTree,
  isEditTool,
  isFileEditTool,
  isGitRepo,
  isShellTool,
  isTaskCreateTool,
  isTaskListTool,
  isTaskTrackingExemptShellCommand,
  isTerminalTaskStatus,
  isWriteTool,
  mergeActionPlanIntoTasks,
  messageFromUnknownError,
  preToolUseAllow,
  preToolUseAllowWithContext,
  preToolUseDeny,
  preToolUseDenyTaskFileAccess,
  preToolUseDenyWithSystemMessage,
  resolveSafeSessionId,
  scheduleAutoSteer,
} from "../src/utils/hook-utils.ts"

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

function taskUpdateToolName(): string {
  return getTaskToolName("TaskUpdate")
}

function taskCreateToolName(): string {
  return getTaskToolName("TaskCreate")
}

function taskHomeForInput(input: Record<string, any>): string | undefined {
  const value = input._taskHome
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resolveGovernanceThresholds(auditStrictness: string): GovernanceThresholds {
  const mode = auditStrictness as keyof typeof GOVERNANCE_THRESHOLDS
  return GOVERNANCE_THRESHOLDS[mode] ?? GOVERNANCE_THRESHOLDS.strict
}

function denyTaskGovernance(request: TaskGovernanceMessageRequest): SwizHookOutput {
  const reason = buildTaskGovernanceMessage(request)
  const preview = buildTaskGovernancePreview(request)
  if (preview) return preToolUseDenyWithSystemMessage(reason, preview)
  return preToolUseDeny(reason)
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
    if (!agentHasTaskToolsForHookPayload(input)) return {}
    const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

    const unsupported = Object.keys(toolInput).filter((k) => !TASK_UPDATE_ALLOWED_FIELDS.has(k))
    if (unsupported.length > 0) {
      const allowed = [...TASK_UPDATE_ALLOWED_FIELDS].join(", ")
      const reason =
        `${taskUpdateToolName()} received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
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

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    if (!agentHasTaskToolsForHookPayload(input)) return {}
    const toolInput = input.tool_input as Record<string, any> | undefined
    const subject: string = (toolInput?.subject as string) ?? ""

    const duplicateOutcome = await checkTaskCreateSubjectGovernance(input, subject)
    if (duplicateOutcome) return duplicateOutcome

    const result = detect(subject)
    if (!result.matched) return preToolUseAllow()

    if (await sessionHasHealthyPendingTaskBuffer(input)) return allowCompoundSubjectWithBuffer()

    return preToolUseDeny(formatMessage(result))
  },
}

/**
 * Returns true when the session already has enough pending task buffer to
 * absorb a compound subject without losing planning fidelity.
 */
async function sessionHasHealthyPendingTaskBuffer(input: Record<string, any>): Promise<boolean> {
  try {
    const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
    if (!sessionId) return false
    const allTasks = overlayEventState(
      await readSessionTasksFresh(sessionId, taskHomeForInput(input)),
      sessionId
    )
    return hasHealthyPendingTaskBuffer(allTasks)
  } catch {
    return false
  }
}

function allowCompoundSubjectWithBuffer(): SwizHookOutput {
  const note =
    "Compound subject allowed: session already has a healthy pending task buffer (≥2 pending tasks). " +
    "Consider splitting follow-up work into focused tasks anyway."
  return preToolUseAllowWithContext(note, note)
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

const STALENESS_THRESHOLD = 30
const LARGE_CONTENT_LINE_THRESHOLD = 10
const IN_PROGRESS_CAP = 4
function canStartInProgress(inProgressCount: number, cap = IN_PROGRESS_CAP): boolean {
  return inProgressCount < cap
}
export function getInProgressCap(): number {
  return IN_PROGRESS_CAP
}

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

/** Layer 1 of the task-file block chain — Edit/Write path guard. See `src/tasks/task-cli-governance.ts` for the two-layer pattern. */
function isBlockedTaskFilesEdit(input: Record<string, any>, toolName: string): boolean {
  if (!isEditTool(toolName) && !isWriteTool(toolName)) return false
  const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
  return isBlockedTaskFilePath(filePath)
}

function buildIncompleteTaskSummary(
  allTasks: Array<{ id: string; status: string; subject: string }>
): {
  incompleteTasks: Array<{ id: string; status: string; subject: string }>
  inProgressTasks: Array<{ id: string; status: string; subject: string }>
  pendingTasks: Array<{ id: string; status: string; subject: string }>
  allTasksDone: boolean
  incompleteTaskList: string
} {
  const incompleteTasks = allTasks.filter((task) => isIncompleteTaskStatus(task.status))
  const inProgressTasks = incompleteTasks.filter((task) => task.status === "in_progress")
  const pendingTasks = incompleteTasks.filter((task) => task.status === "pending")
  const allTasksDone =
    allTasks.length > 0 && allTasks.every((task) => isTerminalTaskStatus(task.status))
  const incompleteTaskList = incompleteTasks
    .map((task) => `  • #${task.id} (${task.status}): ${task.subject}`)
    .join("\n")

  return { incompleteTasks, inProgressTasks, pendingTasks, allTasksDone, incompleteTaskList }
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
        buildTaskGovernanceMessage({
          kind: "prior-session-tasks",
          toolName,
          priorSessionId,
          priorTaskCount: priorTasks.length,
          taskLines,
          completeExamples,
        })
      )
    }

    return preToolUseDeny(buildTaskGovernanceMessage({ kind: "no-tasks", toolName, thresholds }))
  }
}

function checkTaskMinimums(
  toolName: string,
  summary: ReturnType<typeof buildIncompleteTaskSummary>,
  thresholds: GovernanceThresholds
): SwizHookOutput | undefined {
  const { incompleteTasks, pendingTasks, allTasksDone, incompleteTaskList } = summary
  if (allTasksDone) {
    return preToolUseDeny(
      buildTaskGovernanceMessage({ kind: "all-tasks-completed", toolName, thresholds })
    )
  }
  if (
    incompleteTasks.length >= thresholds.minIncomplete &&
    pendingTasks.length >= thresholds.minPending
  )
    return undefined

  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "missing-task-minimums",
      toolName,
      incompleteTaskList,
    })
  )
}

async function checkInProgressCap(
  toolName: string,
  sessionId: string,
  cwd: string | undefined,
  allTasks: Array<{ id: string; status: string; subject: string }>
): Promise<SwizHookOutput | undefined> {
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress")
  if (canStartInProgress(inProgressTasks.length)) return undefined
  const taskList = inProgressTasks.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  return await denyAutoSteerOrBlock(
    sessionId,
    cwd,
    buildTaskGovernanceMessage({
      kind: "too-many-in-progress",
      toolName,
      inProgressCount: inProgressTasks.length,
      cap: getInProgressCap(),
      taskList,
    })
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
      buildTaskGovernanceMessage({ kind: "direct-merge-intent", toolName, taskList })
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
  const staleTaskSteps: (string | string[])[] = [
    "Update existing tasks to reflect current reality:",
    [
      `Use ${taskUpdateToolName()} to update in-progress tasks with the latest progress.`,
      "Record completed work only when there is concrete evidence.",
      "Ensure the current work has an in_progress task with a clear description.",
    ],
    `Use ${taskCreateToolName()} to create at least one further task for the next concrete step based on the work underway.`,
    stateStep,
  ]
  const stalePlanSteps: (string | string[])[] = [
    TASKLIST_STABILITY_STEP,
    ...staleTaskSteps,
    TASKLIST_CONFIRM_STEP,
  ]
  const sid = (input as Record<string, any>).session_id as string | undefined
  if (sid) await mergeActionPlanIntoTasks(staleTaskSteps, sid, cwd)
  return await denyAutoSteerOrBlock(
    sessionId,
    cwd,
    buildTaskGovernanceMessage({
      kind: "stale-tasks",
      callsSinceLastTaskTool,
      toolName,
      taskList,
      planSteps: stalePlanSteps,
    })
  )
}

async function checkCanonicalTaskListSync(
  toolName: string,
  sessionId: string,
  allTasks: Array<{ id: string; status: string; subject: string }>
): Promise<SwizHookOutput | undefined> {
  if (isTaskListTool(toolName) || isTaskCreateTool(toolName)) return undefined

  const lastSyncAtMs = await readCanonicalTaskListSyncAtMs(sessionId)
  const ageMs = lastSyncAtMs === null ? null : Date.now() - lastSyncAtMs
  if (ageMs !== null && ageMs <= CANONICAL_TASKLIST_SYNC_MAX_AGE_MS) {
    return undefined
  }
  if (isFileEditTool(toolName) && hasHealthyTaskBuffer(allTasks)) return undefined

  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "canonical-tasklist-stale",
      toolName,
    })
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
  if (!agentHasTaskToolsForHookPayload(input)) return false
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
    buildTaskGovernanceMessage({
      kind: "task-deletion-threshold",
      taskId: ctx.taskId,
      toolName: ctx.toolName,
    })
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

const PENDING_TASK_OVERFLOW_LIMIT = 20

function checkPendingOverflow(
  toolName: string,
  allTasks: Array<{ id: string; status: string; subject: string }>
): SwizHookOutput | undefined {
  if (isTaskListTool(toolName)) return undefined
  const pendingCount = allTasks.filter((t) => t.status === "pending").length
  if (pendingCount <= PENDING_TASK_OVERFLOW_LIMIT) return undefined

  return preToolUseDeny(buildTaskGovernanceMessage({ kind: "pending-overflow", toolName }))
}

function buildDuplicateSubjectStateBlock(
  toolName: string,
  groups: ReturnType<typeof findDuplicateSubjectGroups>
): SwizHookOutput {
  return preToolUseDeny(
    buildTaskGovernanceMessage({ kind: "duplicate-subject-state", toolName, groups })
  )
}

function buildTaskCreateDuplicateSubjectBlock(
  subject: string,
  collision: TaskSubjectEntry
): SwizHookOutput {
  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "duplicate-subject-create",
      subject,
      collisionId: collision.id,
    })
  )
}

function buildTaskUpdateDuplicateSubjectBlock(
  taskId: string,
  groups: ReturnType<typeof findDuplicateSubjectGroups>
): SwizHookOutput {
  return preToolUseDeny(
    buildTaskGovernanceMessage({ kind: "duplicate-subject-update", taskId, groups })
  )
}

function checkDuplicateSubjectResolution(
  toolName: string,
  input: Record<string, any>,
  allTasks: ReadonlyArray<TaskSubjectEntry>
): SwizHookOutput | undefined {
  const groups = findDuplicateSubjectGroups(allTasks)
  if (groups.length === 0 || isTaskListTool(toolName)) return undefined

  if (toolName === "TaskUpdate") {
    const toolInput = (input.tool_input ?? {}) as Record<string, any>
    const taskId = String(toolInput.taskId ?? "")
    const beforeSeverity = duplicateSubjectSeverity(groups)
    const preview = applyTaskUpdatePreview(allTasks, taskId, {
      status: toolInput.status ? String(toolInput.status) : undefined,
      subject: typeof toolInput.subject === "string" ? toolInput.subject : undefined,
    })
    const afterGroups = findDuplicateSubjectGroups(preview)
    const afterSeverity = duplicateSubjectSeverity(afterGroups)
    const touchesDuplicate = taskIdIsInDuplicateGroups(taskId, groups)
    if (afterGroups.length === 0) return undefined
    if (touchesDuplicate && afterSeverity < beforeSeverity) return undefined
  }

  return buildDuplicateSubjectStateBlock(toolName, groups)
}

async function readTaskSubjectEntries(
  sessionId: string,
  home?: string
): Promise<TaskSubjectEntry[]> {
  return overlayEventState(await readSessionTasksFresh(sessionId, home), sessionId)
}

async function checkTaskCreateSubjectGovernance(
  input: Record<string, any>,
  subject: string
): Promise<SwizHookOutput | undefined> {
  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return undefined

  const allTasks = await readTaskSubjectEntries(sessionId, taskHomeForInput(input))
  const duplicateState = checkDuplicateSubjectResolution(
    String(input.tool_name ?? "TaskCreate"),
    input,
    allTasks
  )
  if (duplicateState) return duplicateState

  const collision = findDuplicateSubjectCollision(subject, allTasks)
  if (!collision) return undefined
  return buildTaskCreateDuplicateSubjectBlock(subject, collision)
}

async function checkTaskUpdateSubjectGovernance(
  input: Record<string, any>,
  sessionId: string
): Promise<SwizHookOutput | undefined> {
  const allTasks = await readTaskSubjectEntries(sessionId, taskHomeForInput(input))
  const duplicateState = checkDuplicateSubjectResolution("TaskUpdate", input, allTasks)
  if (duplicateState) return duplicateState

  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  if (typeof toolInput.subject !== "string") return undefined
  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return undefined

  const preview = applyTaskUpdatePreview(allTasks, taskId, {
    status: toolInput.status ? String(toolInput.status) : undefined,
    subject: toolInput.subject,
  })
  const groups = findDuplicateSubjectGroups(preview)
  if (groups.length === 0) return undefined
  return buildTaskUpdateDuplicateSubjectBlock(taskId, groups)
}

async function runTaskStateChecks(
  toolName: string,
  sessionId: string,
  cwd: string,
  allTasks: Array<{ id: string; status: string; subject: string }>,
  activeTasks: string[],
  thresholds: GovernanceThresholds,
  input: Record<string, any>,
  transcriptPath: string
): Promise<SwizHookOutput> {
  if (needsReconciliation(sessionId) && isBlockedTool(toolName) && !isTaskListTool(toolName)) {
    return preToolUseDeny(buildTaskGovernanceMessage({ kind: "reconciliation-required", toolName }))
  }

  const taskListSyncOutcome = await checkCanonicalTaskListSync(toolName, sessionId, allTasks)
  if (taskListSyncOutcome) return taskListSyncOutcome

  const pendingOverflowOutcome = checkPendingOverflow(toolName, allTasks)
  if (pendingOverflowOutcome) return pendingOverflowOutcome

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

  return (await emitSlowTaskWarning(allTasks, sessionId, cwd)) ?? {}
}

async function runRequireTasksChecks(parsed: ParsedInput): Promise<SwizHookOutput> {
  const { input, toolName, sessionId, transcriptPath, cwd } = parsed
  // Layer 1: Edit/Write file-path guard (see task-cli-governance.ts)
  if (isBlockedTaskFilesEdit(input, toolName)) {
    const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: filePath,
      sessionId,
    })
  }
  const command = String(input.tool_input?.command ?? "")
  // Layer 2: Shell command guard — catches cat, jq, pipes, redirects, subshells
  if (isBlockedSwizTaskFilesCommand(command)) {
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: command,
      sessionId,
    })
  }

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

  const duplicateSubjectOutcome = checkDuplicateSubjectResolution(toolName, input, allTasks)
  if (duplicateSubjectOutcome) return duplicateSubjectOutcome

  return await runTaskStateChecks(
    toolName,
    sessionId,
    cwd,
    allTasks,
    activeTasks,
    thresholds,
    input,
    transcriptPath
  )
}

function unexpectedHookFailureOutput(err: unknown): SwizHookOutput {
  const message = messageFromUnknownError(err)
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
  if (!agentHasTaskToolsForHookPayload(input)) return {}

  const toolName = String(input.tool_name ?? "")
  if (isBlockedTool(toolName) && isBlockedTaskFilesEdit(input, toolName)) {
    const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: filePath,
    })
  }
  const command = String((input.tool_input as Record<string, any> | undefined)?.command ?? "")
  if (isBlockedTool(toolName) && isBlockedSwizTaskFilesCommand(command)) {
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: command,
    })
  }

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

function shouldInspectShellInput(input: {
  tool_name?: string
  _env?: Record<string, string>
}): boolean {
  if (!isShellTool(input?.tool_name ?? "")) return false
  const payloadAgent = input?._env ? detectCurrentAgentFromEnv(input._env)?.id : undefined
  const envAgent = detectCurrentAgentFromEnv()?.id
  // Prefer the dispatching agent's env (payload._env) over the daemon's
  // process.env, which may be polluted with CODEX_* vars from launchctl.
  // Default to "claude" when neither source identifies an agent.
  const agent = payloadAgent ?? envAgent ?? "claude"
  return agent === "claude"
}

// ─── Sliding-window completion rate limiter ─────────────────────────────────

const WINDOW_MS = 5_000
const MAX_COMPLETIONS_IN_WINDOW = 2

const completionTimestamps = new Map<string, number[]>()

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS
  return timestamps.filter((t) => t > cutoff)
}

interface TaskCounts {
  pending: number
  inProgress: number
}

function checkCompletionRateLimit(
  sessionId: string,
  taskCounts?: TaskCounts
): SwizHookOutput | null {
  const now = Date.now()
  const existing = completionTimestamps.get(sessionId) ?? []
  const recent = pruneWindow(existing, now)

  if (recent.length >= MAX_COMPLETIONS_IN_WINDOW) {
    // Bypass rate limit when the planning buffer is healthy: the agent has
    // enough pending tasks queued that rapid completions are intentional
    // progress, not governance-bypassing shortcuts.
    if (taskCounts && taskCounts.pending >= 2 && taskCounts.inProgress >= 1) {
      recent.push(now)
      completionTimestamps.set(sessionId, recent)
      return null
    }

    completionTimestamps.set(sessionId, recent)
    const oldestInWindow = recent[0] ?? now
    const waitSec = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000)
    return denyTaskGovernance({
      kind: "completion-rate-limit",
      recentCompletionCount: recent.length,
      maxCompletions: MAX_COMPLETIONS_IN_WINDOW,
      waitSeconds: waitSec,
      sessionId,
    })
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
    // Overlay in-memory event state for TOCTOU safety on parallel deletions.
    const diskTasks = await readSessionTasks(sessionId)
    const allTasks = overlayEventState(diskTasks, sessionId)
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

      // Allow early deletion if thresholds are still met after deletion.
      // This allows deleting incomplete tasks as long as governance minimums are maintained.
      const violatesThresholds =
        incompleteAfterDelete < thresholds.minIncomplete ||
        pendingAfterDelete < thresholds.minPending

      if (violatesThresholds) {
        return preToolUseDeny(
          buildTaskGovernanceMessage({
            kind: "native-deletion-threshold",
            taskId,
          })
        )
      }
    }
    // Optimistically record allowed deletion in event state + cache (TOCTOU fix).
    applyTaskUpdateEvent(sessionId, taskId, { status: "deleted" })
    if (taskBeingDeleted)
      applyCacheTaskUpdate(sessionId, { ...taskBeingDeleted, status: "deleted" })
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
  // Read tasks first so counts are available for the rate-limit bypass check.
  const diskTasks = await readSessionTasks(sessionId)
  const allTasks = overlayEventState(diskTasks, sessionId)

  const incompleteBefore = allTasks.filter((t) => isIncompleteTaskStatus(t.status))
  const pendingBefore = incompleteBefore.filter((t) => t.status === "pending")
  const inProgressBefore = incompleteBefore.filter((t) => t.status === "in_progress")
  const rateLimited = checkCompletionRateLimit(sessionId, {
    pending: pendingBefore.length,
    inProgress: inProgressBefore.length,
  })
  if (rateLimited) return rateLimited

  // Check governance thresholds: completing this task must not drop
  // pending count below 2, even if it drops incomplete below the minimum.
  const taskBeingCompleted = allTasks.find((t) => t.id === taskId)

  if (taskBeingCompleted && isIncompleteTaskStatus(taskBeingCompleted.status)) {
    let thresholds: GovernanceThresholds = GOVERNANCE_THRESHOLDS.strict
    try {
      const [settings, projectSettings] = await Promise.all([
        readSwizSettings(),
        cwd ? readProjectSettings(cwd).catch(() => null) : Promise.resolve(null),
      ])
      const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings ?? undefined)
      thresholds = resolveGovernanceThresholds(effective.auditStrictness)
    } catch {
      // Fall through with strict defaults
    }

    const incompleteTasks = allTasks.filter((t) => isIncompleteTaskStatus(t.status))
    const pendingTasks = incompleteTasks.filter((t) => t.status === "pending")
    const incompleteAfter = incompleteTasks.length - 1
    const pendingAfter =
      taskBeingCompleted.status === "pending" ? pendingTasks.length - 1 : pendingTasks.length

    // Allow early completion if at least 2 pending tasks remain (sufficient planning buffer).
    // This relaxes the strict minIncomplete requirement while maintaining minPending threshold.
    const allowEarlyCompletion = pendingAfter >= 2
    const violatesThresholds =
      !allowEarlyCompletion &&
      (incompleteAfter < thresholds.minIncomplete || pendingAfter < thresholds.minPending)

    if (violatesThresholds) {
      return denyTaskGovernance({
        kind: "completion-threshold",
        taskId,
      })
    }

    // Optimistically record in event state + cache for parallel TOCTOU safety.
    applyTaskUpdateEvent(sessionId, taskId, { status: "completed" })
    applyCacheTaskUpdate(sessionId, { ...taskBeingCompleted, status: "completed" })
  }

  return null
}

async function checkInProgressTransitionCap(
  taskId: string,
  sessionId: string,
  home?: string
): Promise<SwizHookOutput | null> {
  const allTasks = await readSessionTasks(sessionId, home)
  const inProgressCount = allTasks.filter((t) => t.status === "in_progress").length
  const currentTask = allTasks.find((t) => t.id === taskId)

  // Allow transition to in_progress if:
  // 1. The task is already in_progress (no-op), or
  // 2. There is room under the configured in-progress cap.
  if (!currentTask || currentTask.status === "in_progress") {
    return null
  }
  if (canStartInProgress(inProgressCount)) {
    return null
  }

  // Block: in-progress count is at or above the configured cap.
  const inProgressTasks = allTasks
    .filter((t) => t.status === "in_progress")
    .map((t) => `  • #${t.id}: ${t.subject}`)
    .join("\n")

  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "in-progress-transition-cap",
      taskId,
      inProgressCount,
      cap: getInProgressCap(),
      taskList: inProgressTasks,
    })
  )
}

type NativeTaskUpdateResult = SwizHookOutput | "early_exit" | "continue"

async function handleNativeInProgressUpdate(
  taskId: string,
  sessionId: string,
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const taskHome = taskHomeForInput(input)
  const transitionDenied = await checkInProgressTransitionCap(taskId, sessionId, taskHome)
  if (transitionDenied) return transitionDenied
  // Optimistically record in event state + cache for parallel TOCTOU safety.
  const allTasks = await readSessionTasks(sessionId, taskHome)
  const currentTask = allTasks.find((t) => t.id === taskId)
  if (currentTask && currentTask.status !== "in_progress") {
    applyTaskUpdateEvent(sessionId, taskId, { status: "in_progress" })
    applyCacheTaskUpdate(sessionId, { ...currentTask, status: "in_progress" })
  }
  return "continue"
}

async function checkNativeTaskUpdateCompletion(
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return "early_exit"

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return "early_exit"

  const cwd = (input.cwd as string) ?? undefined
  const duplicateSubjectDenied = await checkTaskUpdateSubjectGovernance(input, sessionId)
  if (duplicateSubjectDenied) return duplicateSubjectDenied

  if (toolInput.status === "deleted") {
    const deletionDenied = await handleTaskDeletionCompletion(taskId, sessionId, cwd)
    if (deletionDenied) return deletionDenied
    return "continue"
  }

  if (toolInput.status === "in_progress") {
    return await handleNativeInProgressUpdate(taskId, sessionId, input)
  }

  if (toolInput.status !== "completed") return "early_exit"

  // Reject shortcut completion from a merely planned task. The user-facing
  // message deliberately describes the behavior being prevented rather than
  // handing over a mechanical transition recipe.
  const allTasks = await readSessionTasks(sessionId)
  const currentTask = allTasks.find((t) => t.id === taskId)
  if (currentTask && currentTask.status === "pending") {
    return denyTaskGovernance({
      kind: "pending-completion-shortcut",
      taskId,
      subject: currentTask.subject,
    })
  }

  const completionDenied = await handleTaskCompletion(taskId, sessionId, cwd)
  if (completionDenied) return completionDenied
  return "continue"
}

export async function runSwizTasksEnforcement(input: Record<string, any>): Promise<SwizHookOutput> {
  const command = String((input.tool_input as Record<string, any> | undefined)?.command ?? "")
  const sessionId = String(input.session_id ?? "")
  const cwd = (input.cwd as string) ?? undefined

  if (isBlockedSwizTaskFilesCommand(command)) {
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      blockedPath: command,
      sessionId,
    })
  }

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
  if (!agentHasTaskToolsForHookPayload(rec)) return {}
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

type ParsedGovernanceInput = ReturnType<typeof toolHookInputSchema.parse>

/**
 * Pre-screen: reject any blocked-tool attempt to edit swiz task files or
 * run a swiz CLI command that mutates task files. Applies even outside a
 * recognized project root so task-state tampering is always blocked.
 */
export function evaluateBlockedTaskFilesPrecheck(
  input: Record<string, any>,
  toolName: string,
  toolInput: Record<string, any>
): SwizHookOutput | null {
  if (!isBlockedTool(toolName)) return null
  if (isBlockedTaskFilesEdit(input, toolName)) {
    const filePath = String(toolInput.file_path ?? "")
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: filePath,
    })
  }
  const command = String(toolInput.command ?? "")
  if (isBlockedSwizTaskFilesCommand(command)) {
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: command,
    })
  }
  return null
}

/**
 * Global pending-task overflow guard. Returns the deny outcome when pending
 * tasks exceed the overflow limit and a TaskList sync is required; null when
 * no block fires or the check is not applicable (TaskList itself, agent
 * without task tools, missing session, non-enforcement project).
 */
export async function evaluatePendingOverflowGuard(
  input: Record<string, any>,
  toolName: string
): Promise<SwizHookOutput | null> {
  if (isTaskListTool(toolName)) return null
  if (!agentHasTaskToolsForHookPayload(input)) return null

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  const cwd: string = (input.cwd as string) ?? process.cwd()
  if (!sessionId) return null
  if (!(await isTaskEnforcementProject(cwd))) return null

  const allTasks = overlayEventState(await readSessionTasksFresh(sessionId), sessionId)
  return checkPendingOverflow(toolName, allTasks) ?? null
}

/**
 * Native TaskUpdate / update_plan branch. Validates allowed schema fields,
 * runs completion / deletion / rate-limit governance, and runs CLI input
 * enforcement when the call is a shell-based task command.
 */
export async function evaluateNativeTaskUpdatePath(
  input: Record<string, any>,
  toolInput: Record<string, any>,
  parsed: ParsedGovernanceInput
): Promise<SwizHookOutput> {
  const unsupported = Object.keys(toolInput).filter((k) => !TASK_UPDATE_ALLOWED_FIELDS.has(k))
  if (unsupported.length > 0) {
    const allowed = [...TASK_UPDATE_ALLOWED_FIELDS].join(", ")
    return preToolUseDeny(
      `${taskUpdateToolName()} received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
        `Allowed fields: ${allowed}.`
    )
  }

  const n = await checkNativeTaskUpdateCompletion(input)
  if (n === "early_exit") return {}
  if (n !== "continue") return n

  if (shouldInspectShellInput(parsed)) {
    return await runSwizTasksEnforcement(input)
  }
  return {}
}

/**
 * TaskCreate / TodoWrite branch. Enforces subject governance (duplicate
 * detection) and rejects compound or task-shaped subjects via the central
 * subject detector unless the pending task buffer is already healthy.
 */
export async function evaluateTaskCreatePath(
  input: Record<string, any>,
  toolInput: Record<string, any>
): Promise<SwizHookOutput> {
  const subject: string = (toolInput?.subject as string) ?? ""
  const duplicateOutcome = await checkTaskCreateSubjectGovernance(input, subject)
  if (duplicateOutcome) return duplicateOutcome

  const result = detect(subject)
  if (result.matched) {
    if (await sessionHasHealthyPendingTaskBuffer(input)) return allowCompoundSubjectWithBuffer()
    return preToolUseDeny(formatMessage(result))
  }
  return preToolUseAllow()
}

/**
 * Edit / Write / Bash branch. Applies project-scope guard conditions,
 * blocked-task-file deny, CLI enforcement when applicable, and the full
 * require-tasks check pipeline. Empty-output early-exit when guards fail.
 */
export async function evaluateBlockedToolPath(
  input: Record<string, any>,
  parsed: ParsedGovernanceInput,
  toolName: string
): Promise<SwizHookOutput> {
  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  const cwd: string = (input.cwd as string) ?? process.cwd()

  if (!validateGuardConditions(sessionId, toolName, input)) return {}
  if (!(await isTaskEnforcementProject(cwd))) return {}

  const transcriptPath: string = (input.transcript_path as string) ?? ""

  if (isBlockedTaskFilesEdit(input, toolName)) {
    const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: filePath,
      sessionId: sessionId ?? undefined,
    })
  }

  if (shouldInspectShellInput(parsed)) {
    const cliResult = await runSwizTasksEnforcement(input)
    if (cliResult && Object.keys(cliResult).length > 0) {
      const hso = (cliResult as Record<string, any>).hookSpecificOutput as
        | Record<string, any>
        | undefined
      if (hso?.permissionDecision === "deny") return cliResult
    }
  }

  return await runRequireTasksChecks({
    input,
    toolName,
    sessionId: sessionId as string,
    transcriptPath,
    cwd,
  })
}

/**
 * Catch-all branch for non-blocked tools. Runs the `swiz tasks` CLI
 * enforcement pass for shell calls that may invoke the CLI directly;
 * returns an empty output otherwise.
 */
export async function evaluateOtherShellToolPath(
  input: Record<string, any>,
  parsed: ParsedGovernanceInput
): Promise<SwizHookOutput> {
  if (shouldInspectShellInput(parsed)) {
    return await runSwizTasksEnforcement(input)
  }
  return {}
}

async function evaluatePretooluseTaskGovernance(rawInput: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(rawInput)
  const input = parsed as unknown as Record<string, any>
  if (!agentHasTaskToolsForHookPayload(input)) return {}
  const toolName = String(input.tool_name ?? "")
  const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

  const blockedTaskFiles = evaluateBlockedTaskFilesPrecheck(input, toolName, toolInput)
  if (blockedTaskFiles) return blockedTaskFiles

  const overflow = await evaluatePendingOverflowGuard(input, toolName)
  if (overflow) return overflow

  if (isNativeTaskTool(toolName)) {
    return await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
  }
  if (isTaskCreateTool(toolName)) {
    return await evaluateTaskCreatePath(input, toolInput)
  }
  if (isBlockedTool(toolName)) {
    return await evaluateBlockedToolPath(input, parsed, toolName)
  }
  return await evaluateOtherShellToolPath(input, parsed)
}

function isDenyOutput(out: SwizHookOutput | null | undefined): boolean {
  if (!out || typeof out !== "object") return false
  const hso = (out as Record<string, any>).hookSpecificOutput as Record<string, any> | undefined
  return hso?.permissionDecision === "deny"
}

function buildDeferralTaskContext(
  allTasks: Array<{ status: string; subject: string }>
): string | null {
  const deferralTaskCount = allTasks.filter(
    (task) => isIncompleteTaskStatus(task.status) && isTaskSubjectWorkDeferral(task.subject)
  ).length
  if (deferralTaskCount === 0) return null

  const subjectText = deferralTaskCount === 1 ? "task subject" : "task subjects"
  const verb = deferralTaskCount === 1 ? "uses" : "use"
  return (
    `Deferral tactic detected: ${deferralTaskCount} active ${subjectText} ${verb} deferral framing. ` +
    "All work is to be completed in this session. There is no follow-up session. " +
    "Replace it with concrete current-session work, start it now, or record a real blocker with evidence."
  )
}

function withDeferralTaskContext(baseContext: string, deferralContext: string | null): string {
  return deferralContext ? `${baseContext}\n\n${deferralContext}` : baseContext
}

async function readTaskCountsForTrace(
  sessionId: string | null,
  input: Record<string, any>
): Promise<{
  allTasks: Array<{ id: string; status: string; subject: string }>
  pending: number
  inProgress: number
  total: number
}> {
  if (!sessionId) return { allTasks: [], pending: 0, inProgress: 0, total: 0 }
  const allTasks = overlayEventState(
    await readSessionTasksFresh(sessionId, taskHomeForInput(input)),
    sessionId
  )
  let pending = 0
  let inProgress = 0
  for (const t of allTasks) {
    if (t.status === "pending") pending++
    else if (t.status === "in_progress") inProgress++
  }
  return { allTasks, pending, inProgress, total: allTasks.length }
}

async function buildTraceContext(rawInput: unknown): Promise<string> {
  try {
    const input = rawInput as Record<string, any>
    const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
    const { allTasks, pending, inProgress, total } = await readTaskCountsForTrace(sessionId, input)

    const stateLead = formatTaskStateLead({
      total,
      incomplete: pending + inProgress,
      pending,
      inProgress,
    })
    const deferralContext = buildDeferralTaskContext(allTasks)

    if (total === 0 || (pending === 0 && inProgress === 0)) {
      return withDeferralTaskContext(
        replaceTaskGovernanceSynonyms(
          `${stateLead} What are we working on? Create tasks before starting implementation.`
        ),
        deferralContext
      )
    }
    if (inProgress === 0) {
      return withDeferralTaskContext(
        replaceTaskGovernanceSynonyms(
          `${stateLead} What are we currently working on? Claim a pending task with TaskUpdate before starting.`
        ),
        deferralContext
      )
    }
    if (pending <= 1) {
      const cwd = input?.cwd as string | undefined
      const hints = await fetchIssueHints(cwd)
      const hintSuffix =
        !deferralContext && hints.length > 0 ? ` Open issues to consider: ${hints.join("; ")}.` : ""
      const bufferMsg =
        pending === 0
          ? `${stateLead} What should we do next? Add a pending task to keep the planning buffer stable.`
          : `${stateLead} What should we do next? Add one more pending task to keep the buffer stable.`
      return withDeferralTaskContext(
        replaceTaskGovernanceSynonyms(`${bufferMsg}${hintSuffix}`),
        deferralContext
      )
    }
    return withDeferralTaskContext(
      replaceTaskGovernanceSynonyms(`${stateLead} On track — good task hygiene.`),
      deferralContext
    )
  } catch (err) {
    return `Task state unavailable: ${(err as Error)?.message ?? err}`
  }
}

const pretooluseTaskGovernance: SwizToolHook = {
  name: "pretooluse-task-governance",
  event: "preToolUse",
  timeout: 5,

  async run(input) {
    try {
      const result = await evaluatePretooluseTaskGovernance(input)
      if (isDenyOutput(result)) return result
      const trace = await buildTraceContext(input)
      // Always emit task governance context — never suppress.
      // This ensures the agent always sees its task state and
      // makes governance enforcement visible and auditable.
      return {
        systemMessage: trace,
        hookSpecificOutput: hookSpecificOutputSchema.parse({
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: trace,
          additionalContext: trace,
        }),
      }
    } catch (err: unknown) {
      return unexpectedHookFailureOutput(err)
    }
  },
}

export default pretooluseTaskGovernance
