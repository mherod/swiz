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

import { formatActionPlan, mergeActionPlanIntoTasks } from "../src/action-plan.ts"
import {
  agentDefinitelySupportsTaskList,
  agentHasTaskListToolForHookPayload,
  agentHasTaskToolsForHookPayload,
  detectCurrentAgentFromEnv,
  detectCurrentAgentFromHookPayload,
} from "../src/agent-paths.ts"
import { formatDuration } from "../src/format-duration.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import type { RunSwizHookAsMainOptions, SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import {
  preToolUseAllow,
  preToolUseAllowWithContext,
  preToolUseDeny,
  preToolUseDenyTaskFileAccess,
  preToolUseDenyWithSystemMessage,
} from "../src/SwizHook.ts"
import {
  hookSpecificOutputSchema,
  TASK_UPDATE_ALLOWED_FIELDS,
  toolHookInputSchema,
} from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import {
  getRecentlyUsedToolsForCurrentSession,
  hasActiveSkillForHookPayload,
} from "../src/skill-utils.ts"
import { createTaskStoreForHookPayload } from "../src/task-roots.ts"
import {
  CODEX_UPDATE_PLAN_TOOL_NAMES,
  codexPlanTaskId,
  isCodexPlanTaskId,
} from "../src/tasks/codex-update-plan.ts"
import { hasHealthyPendingTaskBuffer } from "../src/tasks/task-buffer-health.ts"
import {
  isBlockedSwizTaskFilesCommand,
  isBlockedSwizTasksCliCommand,
  isBlockedTaskFilePath,
  SWIZ_TASKS_CLI_DENY_MESSAGE,
} from "../src/tasks/task-cli-governance.ts"
import { getCurrentComplianceEntry } from "../src/tasks/task-compliance-history.ts"
import {
  applyTaskUpdateEvent,
  needsReconciliation,
  overlayEventState,
} from "../src/tasks/task-event-state.ts"
import { isWithinUserMessageGrace } from "../src/tasks/task-governance-grace.ts"
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
  formatTaskSubjectsForDisplay,
  isIncompleteTaskStatus,
  isTerminalTaskStatus,
} from "../src/tasks/task-recovery.ts"
import { readTasks } from "../src/tasks/task-repository.ts"
// validateLastTaskStanding removed — handleTaskCompletion now checks full governance thresholds
import {
  CANONICAL_TASKLIST_SYNC_MAX_AGE_MS,
  readCanonicalTaskListSyncAtMs,
  writeCanonicalTaskListSyncSentinel,
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
import { SWIZ_INCOMING_ROOT } from "../src/temp-paths.ts"
import {
  isAnyProviderTaskListTool,
  isCodeChangeTool,
  isEditTool,
  isFileEditTool,
  isShellTool,
  isTaskCreateTool,
  isTaskListTool,
  isTaskUpdateTool,
  isWriteTool,
} from "../src/tool-matchers.ts"
import { getCurrentSessionTaskToolStats } from "../src/transcript-summary.ts"
import { scheduleAutoSteer } from "../src/utils/auto-steer-helpers.ts"
import { hasFileInTree } from "../src/utils/file-utils.ts"
import { messageFromUnknownError } from "../src/utils/hook-json-helpers.ts"
import {
  readNativeTaskToolAvailability,
  shouldEnforceTaskGovernance,
} from "../src/utils/inline-hook-helpers.ts"

// ─── Shared governance infrastructure ──────────────────────────────────────

/**
 * True when this session provably lacks the native task tools.
 *
 * Governance reads the native task store, which only the native tools write to. When they are
 * missing, every gate sees an empty queue and prescribes a remedy the agent cannot perform —
 * blocking Edit/Write/Bash with no reachable escape. Standing down is the only safe behaviour;
 * the MCP task tools write to a different store and do not satisfy these checks.
 *
 * Fails open: anything short of proven absence keeps governance active.
 */
async function nativeTaskToolsProvenAbsent(
  input: Record<string, any> | undefined
): Promise<boolean> {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : null
  const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : null
  const availability = await readNativeTaskToolAvailability(
    sessionId,
    SWIZ_INCOMING_ROOT,
    transcriptPath
  )
  return !shouldEnforceTaskGovernance(availability)
}

interface GovernanceThresholds {
  minIncomplete: number
  minPending: number
  minInProgress: number
}

const GOVERNANCE_THRESHOLDS = {
  strict: { minIncomplete: 2, minPending: 1, minInProgress: 1 },
  relaxed: { minIncomplete: 1, minPending: 0, minInProgress: 0 },
  "local-dev": { minIncomplete: 1, minPending: 0, minInProgress: 0 },
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

function taskStoreForInput(input: Record<string, any>) {
  const home = taskHomeForInput(input)
  return home ? createTaskStoreForHookPayload(input, home) : createTaskStoreForHookPayload(input)
}

async function readTasksForInput(input: Record<string, any>, sessionId: string) {
  return await readTasks(sessionId, taskStoreForInput(input).tasksDir)
}

function hasTaskGovernanceSurface(input: Record<string, any>, toolName: string): boolean {
  return agentHasTaskToolsForHookPayload(input) || isUpdatePlanTool(toolName)
}

function resolveGovernanceThresholds(
  auditStrictness: string,
  autoContinue?: boolean
): GovernanceThresholds {
  const mode = auditStrictness as keyof typeof GOVERNANCE_THRESHOLDS
  const base = GOVERNANCE_THRESHOLDS[mode] ?? GOVERNANCE_THRESHOLDS.strict
  if (autoContinue === false) {
    return {
      minIncomplete: Math.min(base.minIncomplete, 1),
      minPending: 0,
      minInProgress: base.minInProgress,
    }
  }
  return base
}

function taskGovernanceMessage(
  input: Record<string, any>,
  request: TaskGovernanceMessageRequest
): string {
  return buildTaskGovernanceMessage(request, {
    translationAgent: detectCurrentAgentFromHookPayload(input),
  })
}

function isCodexTaskGovernanceExempt(input: Record<string, any>): boolean {
  return detectCurrentAgentFromHookPayload(input)?.id === "codex"
}

function denyTaskGovernance(
  request: TaskGovernanceMessageRequest,
  input?: Record<string, any>
): SwizHookOutput {
  const reason = input ? taskGovernanceMessage(input, request) : buildTaskGovernanceMessage(request)
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
    const toolName = String(input.tool_name ?? "")
    if (!hasTaskGovernanceSurface(input, toolName)) return {}
    const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

    if (isUpdatePlanTool(toolName)) {
      return validateUpdatePlanInput(toolInput) ?? {}
    }

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
    if (duplicateOutcome) {
      // TaskCreate is never hard-denied — downgrade to advisory
      const preview =
        (duplicateOutcome as { systemMessage?: string }).systemMessage ??
        "Duplicate subject — consider using a unique subject."
      return preToolUseAllowWithContext(preview, preview)
    }

    const result = detect(subject)
    if (!result.matched) return preToolUseAllow()

    // Severe matches (many-comma step chains) never earn the buffer exemption.
    if (!result.severe && (await sessionHasHealthyPendingTaskBuffer(input))) {
      return allowCompoundSubjectWithBuffer()
    }

    // Advisory only — TaskCreate never blocks, it can only improve task state
    const msg = formatMessage(result)
    return preToolUseAllowWithContext(msg, msg)
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
    const allTasks = overlayEventState(await readTasksForInput(input, sessionId), sessionId)
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

import { TASK_STALENESS_ENFORCEMENT_THRESHOLD as STALENESS_THRESHOLD } from "../src/tasks/task-governance-constants.ts"

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

async function isTaskEnforcementProject(input: Record<string, any>, cwd: string): Promise<boolean> {
  if (!(await isGitRepoForHookPayload(input, cwd))) return false
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

function evaluateTaskFileAccess(
  input: Record<string, any>,
  toolName: string,
  sessionId?: string
): SwizHookOutput | null {
  if (!isBlockedTool(toolName)) return null
  if (isBlockedTaskFilesEdit(input, toolName)) {
    const filePath = String((input.tool_input as Record<string, any> | undefined)?.file_path ?? "")
    return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
      toolName,
      blockedPath: filePath,
      sessionId,
    })
  }

  const command = String((input.tool_input as Record<string, any> | undefined)?.command ?? "")
  if (!isBlockedSwizTaskFilesCommand(command)) return null
  return preToolUseDenyTaskFileAccess(SWIZ_TASKS_FILES_DENY_MESSAGE, {
    toolName,
    blockedPath: command,
    sessionId,
  })
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
  thresholds: GovernanceThresholds
): (
  allTasks: Array<{ id: string; status: string; subject: string }>
) => SwizHookOutput | undefined {
  return (allTasks) => {
    if (allTasks.length !== 0) return undefined
    return preToolUseDeny(buildTaskGovernanceMessage({ kind: "no-tasks", toolName, thresholds }))
  }
}

function checkTaskMinimums(
  toolName: string,
  summary: ReturnType<typeof buildIncompleteTaskSummary>,
  thresholds: GovernanceThresholds
): SwizHookOutput | undefined {
  const { incompleteTasks, inProgressTasks, pendingTasks, allTasksDone, incompleteTaskList } =
    summary
  if (allTasksDone) {
    return preToolUseDeny(
      buildTaskGovernanceMessage({ kind: "all-tasks-completed", toolName, thresholds })
    )
  }
  if (
    incompleteTasks.length >= thresholds.minIncomplete &&
    inProgressTasks.length >= thresholds.minInProgress &&
    pendingTasks.length >= thresholds.minPending
  )
    return undefined

  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "missing-task-minimums",
      toolName,
      incompleteTaskList,
      thresholds,
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
    const settings = await readSwizSettings({ strict: true })
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
  const stalePlanSteps: (string | string[])[] = agentDefinitelySupportsTaskList(
    detectCurrentAgentFromHookPayload(input)
  )
    ? [TASKLIST_STABILITY_STEP, ...staleTaskSteps, TASKLIST_CONFIRM_STEP]
    : staleTaskSteps
  const sid = (input as Record<string, any>).session_id as string | undefined
  if (sid) await mergeActionPlanIntoTasks(staleTaskSteps, sid, cwd)
  return await denyAutoSteerOrBlock(
    sessionId,
    cwd,
    taskGovernanceMessage(input, {
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
  input: Record<string, any>
): Promise<SwizHookOutput | undefined> {
  if (isTaskListTool(toolName) || isTaskCreateTool(toolName) || isUpdatePlanTool(toolName)) {
    return undefined
  }
  if (!agentHasTaskListToolForHookPayload(input)) return undefined
  if (isFileEditTool(toolName)) return undefined

  const lastSyncAtMs = await readCanonicalTaskListSyncAtMs(sessionId)
  const ageMs = lastSyncAtMs === null ? null : Date.now() - lastSyncAtMs
  if (ageMs !== null && ageMs <= CANONICAL_TASKLIST_SYNC_MAX_AGE_MS) {
    return undefined
  }

  // Sentinel missing or stale — check transcript evidence before denying. The
  // sentinel's only writer is the PostToolUse TaskList sync hook; when that
  // event does not dispatch for the current agent, denying on the absent
  // sentinel turns the "Run TaskList now" remediation into an unsatisfiable
  // retry loop. A TaskList call visible in the recent transcript window is
  // direct evidence the sync happened, so accept it and self-heal the sentinel.
  if (await hasRecentTaskListEvidence(input)) {
    await writeCanonicalTaskListSyncSentinel(sessionId)
    return undefined
  }

  return preToolUseDeny(
    taskGovernanceMessage(input, {
      kind: "canonical-tasklist-stale",
      toolName,
    })
  )
}

async function hasRecentTaskListEvidence(input: Record<string, any>): Promise<boolean> {
  try {
    const recentTools = await getRecentlyUsedToolsForCurrentSession(input)
    // Accept MCP task listings too: when the native TaskList is missing from the session, an MCP
    // listing is the only sync the agent can perform, and refusing it makes the "Run TaskList now"
    // remediation unsatisfiable — the retry loop this function exists to prevent.
    return recentTools.some((name) => isAnyProviderTaskListTool(name))
  } catch {
    // Transcript unavailable — the caller falls through to the deny.
    return false
  }
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
      readSwizSettings({ strict: true }),
      readProjectSettings(cwd, { strict: true }),
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
  return isMemoryMarkdownEdit(input, toolName)
}

function validateGuardConditions(
  sessionId: string | null | undefined,
  toolName: string,
  input: Record<string, any>
): boolean {
  if (!sessionId || !isBlockedTool(toolName) || !getHomeDirOrNull()) return false
  if (isCodexTaskGovernanceExempt(input)) return false
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
  if (!(await isTaskEnforcementProject(input, parsed.cwd))) return null
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

  if (toolName === "TaskUpdate" && taskUpdateImprovesDuplicateState(input, allTasks, groups)) {
    return undefined
  }

  return buildDuplicateSubjectStateBlock(toolName, groups)
}

function taskUpdateImprovesDuplicateState(
  input: Record<string, any>,
  allTasks: ReadonlyArray<TaskSubjectEntry>,
  groups: ReturnType<typeof findDuplicateSubjectGroups>
): boolean {
  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  const taskId = String(toolInput.taskId ?? "")
  const preview = applyTaskUpdatePreview(allTasks, taskId, {
    status: toolInput.status ? String(toolInput.status) : undefined,
    subject: typeof toolInput.subject === "string" ? toolInput.subject : undefined,
  })
  const afterGroups = findDuplicateSubjectGroups(preview)
  if (afterGroups.length === 0) return true
  if (!taskIdIsInDuplicateGroups(taskId, groups)) return false
  return duplicateSubjectSeverity(afterGroups) < duplicateSubjectSeverity(groups)
}

async function readTaskSubjectEntries(
  input: Record<string, any>,
  sessionId: string
): Promise<TaskSubjectEntry[]> {
  return overlayEventState(await readTasksForInput(input, sessionId), sessionId)
}

async function checkTaskCreateSubjectGovernance(
  input: Record<string, any>,
  subject: string
): Promise<SwizHookOutput | undefined> {
  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return undefined

  const allTasks = await readTaskSubjectEntries(input, sessionId)
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
  const allTasks = await readTaskSubjectEntries(input, sessionId)
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

interface TaskStateCheckContext extends ParsedInput {
  allTasks: Array<{ id: string; status: string; subject: string }>
  activeTasks: string[]
  thresholds: GovernanceThresholds
}

function checkReconciliationRequired(context: TaskStateCheckContext): SwizHookOutput | undefined {
  if (
    !needsReconciliation(context.sessionId) ||
    !isBlockedTool(context.toolName) ||
    isTaskListTool(context.toolName) ||
    !agentHasTaskListToolForHookPayload(context.input)
  ) {
    return undefined
  }
  return preToolUseDeny(
    taskGovernanceMessage(context.input, {
      kind: "reconciliation-required",
      toolName: context.toolName,
    })
  )
}

function runImmediateTaskStateChecks(context: TaskStateCheckContext): SwizHookOutput | undefined {
  const pendingOverflow = checkPendingOverflow(context.toolName, context.allTasks)
  if (pendingOverflow) return pendingOverflow

  const deletion = checkTaskDeletion(
    context.toolName,
    context.allTasks,
    context.thresholds,
    context.input
  )
  if (deletion) return deletion

  const noTasks = checkNoTasks(context.toolName, context.thresholds)(context.allTasks)
  if (noTasks) return noTasks

  return checkTaskMinimums(
    context.toolName,
    buildIncompleteTaskSummary(context.allTasks),
    context.thresholds
  )
}

async function runTaskStateChecks(context: TaskStateCheckContext): Promise<SwizHookOutput> {
  if (await nativeTaskToolsProvenAbsent(context.input)) return preToolUseAllow()

  // Escape hatch: a running skill owns its own ordered workflow, so a state gate firing mid-skill
  // blocks a step the skill itself prescribed. Stand down for the skill's duration.
  if (await hasActiveSkillForHookPayload(context.input, context.cwd)) return preToolUseAllow()

  const reconciliation = checkReconciliationRequired(context)
  if (reconciliation) return reconciliation

  const taskListSyncOutcome = await checkCanonicalTaskListSync(
    context.toolName,
    context.sessionId,
    context.input
  )
  if (taskListSyncOutcome) return taskListSyncOutcome

  const immediateOutcome = runImmediateTaskStateChecks(context)
  if (immediateOutcome) return immediateOutcome

  const capOutcome = await checkInProgressCap(
    context.toolName,
    context.sessionId,
    context.cwd,
    context.allTasks
  )
  if (capOutcome) return capOutcome

  const summary = buildIncompleteTaskSummary(context.allTasks)
  const mergeOutcome = await checkDirectMergeIntent(
    context.toolName,
    context.sessionId,
    context.cwd,
    summary.incompleteTasks
  )
  if (mergeOutcome) return mergeOutcome

  const staleOutcome = await checkTaskStaleness({
    toolName: context.toolName,
    input: context.input,
    transcriptPath: context.transcriptPath,
    allTasks: context.allTasks,
    activeTasks: context.activeTasks,
    allTasksDone: summary.allTasksDone,
    cwd: context.cwd,
    sessionId: context.sessionId,
  })
  if (staleOutcome) return staleOutcome

  return (await emitSlowTaskWarning(context.allTasks, context.sessionId, context.cwd)) ?? {}
}

async function runRequireTasksChecks(parsed: ParsedInput): Promise<SwizHookOutput> {
  const { input, toolName, sessionId, transcriptPath, cwd } = parsed
  // Layer 1: Edit/Write file-path guard (see task-cli-governance.ts)
  const taskFileAccess = evaluateTaskFileAccess(input, toolName, sessionId)
  if (taskFileAccess) return taskFileAccess

  let thresholds: GovernanceThresholds = GOVERNANCE_THRESHOLDS.strict
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings({ strict: true }),
      readProjectSettings(cwd, { strict: true }),
    ])
    const effectiveSettings =
      (input._effectiveSettings as ReturnType<typeof getEffectiveSwizSettings> | undefined) ??
      getEffectiveSwizSettings(settings, sessionId, projectSettings)
    thresholds = resolveGovernanceThresholds(
      effectiveSettings.auditStrictness,
      effectiveSettings.autoContinue
    )
  } catch {
    // Settings read failure → use strict thresholds as default
  }

  const allTasks = overlayEventState(await readTasksForInput(input, sessionId), sessionId)
  const activeTasks = allTasks
    .filter((t) => isIncompleteTaskStatus(t.status))
    .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

  const duplicateSubjectOutcome = checkDuplicateSubjectResolution(toolName, input, allTasks)
  if (duplicateSubjectOutcome) return duplicateSubjectOutcome

  return await runTaskStateChecks({
    input,
    toolName,
    sessionId,
    transcriptPath,
    cwd,
    allTasks,
    activeTasks,
    thresholds,
  })
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
  const taskFileAccess = evaluateTaskFileAccess(input, toolName)
  if (taskFileAccess) return taskFileAccess

  const parsed = await tryParseAndGuard(input)
  if (!parsed) return {}
  // Relax require-tasks pressure within the post-user-message grace window.
  if (await isWithinUserMessageGrace(input)) return {}
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

function checkCompletionRateLimitForCount(
  sessionId: string,
  completionCount: number,
  taskCounts?: TaskCounts
): SwizHookOutput | null {
  if (completionCount <= 0) return null
  const now = Date.now()
  const existing = completionTimestamps.get(sessionId) ?? []
  const recent = pruneWindow(existing, now)

  if (recent.length + completionCount > MAX_COMPLETIONS_IN_WINDOW) {
    // Bypass rate limit when the planning buffer is healthy: the agent has
    // enough pending tasks queued that rapid completions are intentional
    // progress, not governance-bypassing shortcuts.
    if (taskCounts && taskCounts.pending >= 2 && taskCounts.inProgress >= 1) {
      for (let i = 0; i < completionCount; i++) recent.push(now)
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

  for (let i = 0; i < completionCount; i++) recent.push(now)
  completionTimestamps.set(sessionId, recent)
  return null
}

function checkCompletionRateLimit(
  sessionId: string,
  taskCounts?: TaskCounts
): SwizHookOutput | null {
  return checkCompletionRateLimitForCount(sessionId, 1, taskCounts)
}

async function checkNativeTaskDeletionGovernance(
  input: Record<string, any>,
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings({ strict: true }),
      cwd ? readProjectSettings(cwd).catch(() => null) : Promise.resolve(null),
    ])
    // Overlay in-memory event state for TOCTOU safety on parallel deletions.
    const diskTasks = await readTasksForInput(input, sessionId)
    const allTasks = overlayEventState(diskTasks, sessionId)
    const effectiveSettings = getEffectiveSwizSettings(
      settings,
      sessionId,
      projectSettings ?? undefined
    )
    const thresholds = resolveGovernanceThresholds(
      effectiveSettings.auditStrictness,
      effectiveSettings.autoContinue
    )

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
  input: Record<string, any>,
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  return await checkNativeTaskDeletionGovernance(input, taskId, sessionId, cwd)
}

async function resolveGovernanceThresholdsForSession(
  input: Record<string, any>,
  sessionId: string,
  cwd: string | undefined
): Promise<GovernanceThresholds> {
  try {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings({ strict: true }),
      cwd ? readProjectSettings(cwd).catch(() => null) : Promise.resolve(null),
    ])
    const effective =
      (input._effectiveSettings as ReturnType<typeof getEffectiveSwizSettings> | undefined) ??
      getEffectiveSwizSettings(settings, sessionId, projectSettings ?? undefined)
    return resolveGovernanceThresholds(effective.auditStrictness, effective.autoContinue)
  } catch {
    return GOVERNANCE_THRESHOLDS.strict
  }
}

async function enforceTaskCompletionThreshold(
  input: Record<string, any>,
  taskId: string,
  sessionId: string,
  cwd: string | undefined,
  allTasks: Awaited<ReturnType<typeof readTasksForInput>>
): Promise<SwizHookOutput | null> {
  const taskBeingCompleted = allTasks.find((task) => task.id === taskId)
  if (!taskBeingCompleted || !isIncompleteTaskStatus(taskBeingCompleted.status)) return null

  const thresholds = await resolveGovernanceThresholdsForSession(input, sessionId, cwd)
  const incompleteTasks = allTasks.filter((task) => isIncompleteTaskStatus(task.status))
  const pendingTasks = incompleteTasks.filter((task) => task.status === "pending")
  const incompleteAfter = incompleteTasks.length - 1
  const pendingAfter =
    taskBeingCompleted.status === "pending" ? pendingTasks.length - 1 : pendingTasks.length

  // Allow early completion if at least 2 pending tasks remain (sufficient planning buffer)
  // or if auto-continue is disabled (minPending === 0).
  const allowEarlyCompletion =
    pendingAfter >= 2 || (thresholds.minPending === 0 && incompleteAfter >= 0)
  const violatesThresholds =
    !allowEarlyCompletion &&
    (incompleteAfter < thresholds.minIncomplete || pendingAfter < thresholds.minPending)
  if (violatesThresholds) {
    return denyTaskGovernance({ kind: "completion-threshold", taskId }, input)
  }

  // Optimistically record in event state + cache for parallel TOCTOU safety.
  applyTaskUpdateEvent(sessionId, taskId, { status: "completed" })
  applyCacheTaskUpdate(sessionId, { ...taskBeingCompleted, status: "completed" })
  return null
}

async function handleTaskCompletion(
  input: Record<string, any>,
  taskId: string,
  sessionId: string,
  cwd: string | undefined
): Promise<SwizHookOutput | null> {
  // Read tasks first so counts are available for the rate-limit bypass check.
  const diskTasks = await readTasksForInput(input, sessionId)
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
  return await enforceTaskCompletionThreshold(input, taskId, sessionId, cwd, allTasks)
}

async function checkInProgressTransitionCap(
  taskId: string,
  sessionId: string,
  input: Record<string, any>
): Promise<SwizHookOutput | null> {
  const allTasks = await readTasksForInput(input, sessionId)
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

const UPDATE_PLAN_ALLOWED_FIELDS = new Set([
  "explanation",
  "plan",
  "thought",
  "notes",
  "summary",
  "rationale",
  "call_id",
  "id",
])
const UPDATE_PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])
const UPDATE_PLAN_STATUS_ALIASES: Record<string, string> = {
  done: "completed",
  "in-progress": "in_progress",
  canceled: "cancelled",
}

function normalizeUpdatePlanStatus(rawStatus: unknown): string | null {
  if (typeof rawStatus !== "string") return null
  const lower = rawStatus.trim().toLowerCase()
  const mapped = UPDATE_PLAN_STATUS_ALIASES[lower] ?? lower
  return UPDATE_PLAN_STATUSES.has(mapped) ? mapped : null
}

function extractUpdatePlanStep(record: Record<string, any>): string | null {
  const value = record.step ?? record.subject ?? record.description ?? record.title
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim()
  }
  return null
}

interface UpdatePlanTaskInput {
  step: string
  status: string
}

interface ProjectedPlanTask {
  id: string
  subject: string
  status: string
}

interface UpdatePlanProjection {
  existingTasks: ProjectedPlanTask[]
  finalTasks: ProjectedPlanTask[]
}

function isUpdatePlanTool(toolName: string): boolean {
  return CODEX_UPDATE_PLAN_TOOL_NAMES.has(toolName)
}

function unsupportedUpdatePlanFields(toolInput: Record<string, any>): string[] {
  return Object.keys(toolInput).filter((key) => !UPDATE_PLAN_ALLOWED_FIELDS.has(key))
}

function validateUpdatePlanItem(item: unknown, index: number): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `update_plan item ${index + 1} must be an object.`
  }
  const record = item as Record<string, any>
  const step = extractUpdatePlanStep(record)
  if (!step) {
    return `update_plan item ${index + 1} requires a non-empty \`step\`.`
  }
  const status = normalizeUpdatePlanStatus(record.status)
  if (!status) {
    return `update_plan item ${index + 1} has unsupported status \`${String(record.status ?? "")}\`.`
  }
  return null
}

function validateUpdatePlanInput(toolInput: Record<string, any>): SwizHookOutput | null {
  const unsupported = unsupportedUpdatePlanFields(toolInput)
  if (unsupported.length > 0) {
    const allowed = [...UPDATE_PLAN_ALLOWED_FIELDS].join(", ")
    return preToolUseDeny(
      `update_plan received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
        `Allowed fields: ${allowed}.`
    )
  }

  if (!Array.isArray(toolInput.plan)) {
    return preToolUseDeny("update_plan requires a `plan` array.")
  }

  for (const [index, item] of toolInput.plan.entries()) {
    const itemError = validateUpdatePlanItem(item, index)
    if (itemError) return preToolUseDeny(itemError)
  }

  return null
}

function parseUpdatePlanTasks(toolInput: Record<string, any>): UpdatePlanTaskInput[] {
  return (toolInput.plan as Record<string, any>[]).map((item) => ({
    step: extractUpdatePlanStep(item) ?? "",
    status: normalizeUpdatePlanStatus(item.status) ?? String(item.status),
  }))
}

function projectUpdatePlanFinalTasks(
  existingTasks: ProjectedPlanTask[],
  plan: UpdatePlanTaskInput[]
): ProjectedPlanTask[] {
  const existingById = new Map(existingTasks.map((task) => [task.id, task]))
  const finalById = new Map(existingTasks.map((task) => [task.id, { ...task }]))
  const seenPlanIds = new Set<string>()

  for (let index = 0; index < plan.length; index++) {
    const item = plan[index]
    if (!item) continue
    const id = codexPlanTaskId(index)
    seenPlanIds.add(id)
    finalById.set(id, {
      id,
      subject: item.step,
      status: item.status,
    })
  }

  for (const existing of existingById.values()) {
    if (!isCodexPlanTaskId(existing.id) || seenPlanIds.has(existing.id)) continue
    if (isIncompleteTaskStatus(existing.status)) {
      finalById.set(existing.id, { ...existing, status: "cancelled" })
    }
  }

  return [...finalById.values()].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true })
  )
}

function buildProjectedPlanTaskList(
  tasks: ProjectedPlanTask[],
  status: string = "in_progress"
): string {
  return tasks
    .filter((task) => task.status === status)
    .map((task) => `  • #${task.id}: ${task.subject}`)
    .join("\n")
}

async function readUpdatePlanProjection(
  input: Record<string, any>,
  sessionId: string,
  plan: UpdatePlanTaskInput[]
): Promise<UpdatePlanProjection> {
  const existingTasks = (await readTasksForInput(input, sessionId)).map((task) => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
  }))
  return {
    existingTasks,
    finalTasks: projectUpdatePlanFinalTasks(existingTasks, plan),
  }
}

function findCompletedTransitions(projection: UpdatePlanProjection): ProjectedPlanTask[] {
  const existingById = new Map(projection.existingTasks.map((task) => [task.id, task]))
  return projection.finalTasks.filter((task) => {
    const existing = existingById.get(task.id)
    return !!existing && isIncompleteTaskStatus(existing.status) && task.status === "completed"
  })
}

function findPendingCompletionShortcut(
  projection: UpdatePlanProjection
): ProjectedPlanTask | undefined {
  const existingById = new Map(projection.existingTasks.map((task) => [task.id, task]))
  return projection.finalTasks.find(
    (task) => existingById.get(task.id)?.status === "pending" && task.status === "completed"
  )
}

function checkUpdatePlanInProgressCap(projection: UpdatePlanProjection): SwizHookOutput | null {
  const existingInProgress = projection.existingTasks.filter(
    (task) => task.status === "in_progress"
  )
  const finalInProgress = projection.finalTasks.filter((task) => task.status === "in_progress")
  const existingById = new Map(projection.existingTasks.map((task) => [task.id, task]))
  const newlyStarted = finalInProgress.find(
    (task) => existingById.get(task.id)?.status !== "in_progress"
  )

  if (!newlyStarted || finalInProgress.length <= getInProgressCap()) return null

  return preToolUseDeny(
    buildTaskGovernanceMessage({
      kind: "in-progress-transition-cap",
      taskId: newlyStarted.id,
      inProgressCount: Math.max(existingInProgress.length, finalInProgress.length),
      cap: getInProgressCap(),
      taskList: buildProjectedPlanTaskList(finalInProgress),
    })
  )
}

function checkUpdatePlanFinalTaskState(
  projection: UpdatePlanProjection,
  thresholds: GovernanceThresholds
): SwizHookOutput | null {
  const duplicateGroups = findDuplicateSubjectGroups(projection.finalTasks)
  if (duplicateGroups.length > 0)
    return buildDuplicateSubjectStateBlock("update_plan", duplicateGroups)

  const capOutcome = checkUpdatePlanInProgressCap(projection)
  if (capOutcome) return capOutcome

  const pendingOverflowOutcome = checkPendingOverflow("update_plan", projection.finalTasks)
  if (pendingOverflowOutcome) return pendingOverflowOutcome

  const summary = buildIncompleteTaskSummary(projection.finalTasks)
  if (summary.allTasksDone) return null
  return checkTaskMinimums("update_plan", summary, thresholds) ?? null
}

function findDeferralPlanItem(plan: UpdatePlanTaskInput[]): UpdatePlanTaskInput | undefined {
  return plan.find(
    (item) => isIncompleteTaskStatus(item.status) && isTaskSubjectWorkDeferral(item.step)
  )
}

async function checkUpdatePlanDirectMerge(
  projection: UpdatePlanProjection,
  sessionId: string,
  cwd: string
): Promise<SwizHookOutput | undefined> {
  const summary = buildIncompleteTaskSummary(projection.finalTasks)
  return await checkDirectMergeIntent("update_plan", sessionId, cwd, summary.incompleteTasks)
}

function checkUpdatePlanCompletionRate(
  projection: UpdatePlanProjection,
  sessionId: string
): SwizHookOutput | null {
  const finalSummary = buildIncompleteTaskSummary(projection.finalTasks)
  if (finalSummary.allTasksDone) return null

  const beforeSummary = buildIncompleteTaskSummary(projection.existingTasks)
  return checkCompletionRateLimitForCount(sessionId, findCompletedTransitions(projection).length, {
    pending: beforeSummary.pendingTasks.length,
    inProgress: beforeSummary.inProgressTasks.length,
  })
}

async function evaluateUpdatePlanGovernance(
  input: Record<string, any>,
  toolInput: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const validation = validateUpdatePlanInput(toolInput)
  if (validation) return validation

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return "early_exit"

  const cwd = (input.cwd as string) ?? process.cwd()
  const plan = parseUpdatePlanTasks(toolInput)
  const deferralItem = findDeferralPlanItem(plan)
  if (deferralItem) {
    return preToolUseDeny(
      `Deferral tactic detected: task subject "${deferralItem.step}" uses deferral framing. ` +
        "All work is to be completed in this session. There is no follow-up session. " +
        "Replace it with concrete current-session work, start it now, or record a real blocker with evidence."
    )
  }

  const projection = await readUpdatePlanProjection(input, sessionId, plan)
  const pendingCompletionShortcut = findPendingCompletionShortcut(projection)
  if (pendingCompletionShortcut) {
    return denyTaskGovernance(
      {
        kind: "pending-completion-shortcut",
        taskId: pendingCompletionShortcut.id,
        subject: pendingCompletionShortcut.subject,
      },
      input
    )
  }

  const thresholds = await resolveGovernanceThresholdsForSession(input, sessionId, cwd)

  const stateDenied = checkUpdatePlanFinalTaskState(projection, thresholds)
  if (stateDenied) return stateDenied

  const directMergeDenied = await checkUpdatePlanDirectMerge(projection, sessionId, cwd)
  if (directMergeDenied) return directMergeDenied

  const rateLimited = checkUpdatePlanCompletionRate(projection, sessionId)
  if (rateLimited) return rateLimited

  return "continue"
}

async function handleNativeInProgressUpdate(
  taskId: string,
  sessionId: string,
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const transitionDenied = await checkInProgressTransitionCap(taskId, sessionId, input)
  if (transitionDenied) return transitionDenied
  // Optimistically record in event state + cache for parallel TOCTOU safety.
  const allTasks = await readTasksForInput(input, sessionId)
  const currentTask = allTasks.find((t) => t.id === taskId)
  if (currentTask && currentTask.status !== "in_progress") {
    applyTaskUpdateEvent(sessionId, taskId, { status: "in_progress" })
    applyCacheTaskUpdate(sessionId, { ...currentTask, status: "in_progress" })
  }
  return "continue"
}

interface NativeTaskUpdateContext {
  input: Record<string, any>
  toolInput: Record<string, any>
  taskId: string
  sessionId: string
  cwd: string | undefined
}

async function handleNativeTaskUpdateStatus(
  context: NativeTaskUpdateContext
): Promise<NativeTaskUpdateResult> {
  if (context.toolInput.status === "deleted") {
    const deletionDenied = await handleTaskDeletionCompletion(
      context.input,
      context.taskId,
      context.sessionId,
      context.cwd
    )
    return deletionDenied ?? "continue"
  }
  if (context.toolInput.status === "in_progress") {
    return await handleNativeInProgressUpdate(context.taskId, context.sessionId, context.input)
  }
  if (context.toolInput.status !== "completed") return "early_exit"

  // Reject shortcut completion from a merely planned task. The user-facing
  // message deliberately describes the behavior being prevented rather than
  // handing over a mechanical transition recipe.
  const allTasks = await readTasksForInput(context.input, context.sessionId)
  const currentTask = allTasks.find((task) => task.id === context.taskId)
  if (currentTask?.status === "pending") {
    return denyTaskGovernance(
      {
        kind: "pending-completion-shortcut",
        taskId: context.taskId,
        subject: currentTask.subject,
      },
      context.input
    )
  }

  const completionDenied = await handleTaskCompletion(
    context.input,
    context.taskId,
    context.sessionId,
    context.cwd
  )
  return completionDenied ?? "continue"
}

async function checkNativeTaskUpdateCompletion(
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const toolName = String(input.tool_name ?? "")
  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  if (isUpdatePlanTool(toolName)) {
    return await evaluateUpdatePlanGovernance(input, toolInput)
  }

  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return "early_exit"

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return "early_exit"

  const cwd = (input.cwd as string) ?? undefined
  const duplicateSubjectDenied = await checkTaskUpdateSubjectGovernance(input, sessionId)
  if (duplicateSubjectDenied) return duplicateSubjectDenied

  return await handleNativeTaskUpdateStatus({ input, toolInput, taskId, sessionId, cwd })
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
  return toolName === "TaskUpdate" || isUpdatePlanTool(toolName)
}

export async function evaluatePretooluseEnforceTaskupdate(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const rec = parsed as unknown as Record<string, any>
  const toolName = String(rec.tool_name ?? "")
  if (!hasTaskGovernanceSurface(rec, toolName)) return {}

  // Within the post-user-message grace window, skip completion governance (rate
  // limits, thresholds, shortcut blocks) but keep the swiz-tasks-files integrity
  // enforcement below — tampering with task state is never relaxed.
  const withinGrace = await isWithinUserMessageGrace(rec)

  if (isNativeTaskTool(toolName) && !withinGrace) {
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

function validateNativeTaskUpdateInput(toolInput: Record<string, any>): SwizHookOutput | null {
  if (typeof toolInput.subject === "string" && isTaskSubjectWorkDeferral(toolInput.subject)) {
    return preToolUseDeny(
      `Deferral tactic detected: task subject "${toolInput.subject}" uses deferral framing. ` +
        "All work is to be completed in this session. There is no follow-up session. " +
        "Replace it with concrete current-session work, start it now, or record a real blocker with evidence."
    )
  }

  const unsupported = Object.keys(toolInput).filter((key) => !TASK_UPDATE_ALLOWED_FIELDS.has(key))
  if (unsupported.length === 0) return null
  const allowed = [...TASK_UPDATE_ALLOWED_FIELDS].join(", ")
  return preToolUseDeny(
    `${taskUpdateToolName()} received unsupported field(s): ${unsupported.map((field) => `\`${field}\``).join(", ")}.

` + `Allowed fields: ${allowed}.`
  )
}

async function completeNativeTaskUpdatePath(
  input: Record<string, any>,
  parsed: ParsedGovernanceInput
): Promise<SwizHookOutput> {
  const outcome = await checkNativeTaskUpdateCompletion(input)
  if (outcome === "early_exit") return {}
  if (outcome !== "continue") return outcome
  return shouldInspectShellInput(parsed) ? await runSwizTasksEnforcement(input) : {}
}

async function completeUpdatePlanPath(
  input: Record<string, any>,
  toolInput: Record<string, any>,
  parsed: ParsedGovernanceInput
): Promise<SwizHookOutput> {
  const outcome = await evaluateUpdatePlanGovernance(input, toolInput)
  if (outcome === "early_exit") return {}
  if (outcome !== "continue") return outcome
  return shouldInspectShellInput(parsed) ? await runSwizTasksEnforcement(input) : {}
}

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
  return evaluateTaskFileAccess({ ...input, tool_input: toolInput }, toolName)
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
  if (isUpdatePlanTool(toolName)) return null
  if (!hasTaskGovernanceSurface(input, toolName)) return null

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  const cwd: string = (input.cwd as string) ?? process.cwd()
  if (!sessionId) return null
  if (!(await isTaskEnforcementProject(input, cwd))) return null
  // Same escape hatch as runTaskStateChecks — an active skill stands the state gates down.
  if (await hasActiveSkillForHookPayload(input, cwd)) return null

  const allTasks = overlayEventState(await readTasksForInput(input, sessionId), sessionId)
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
  const toolName = String(input.tool_name ?? "")
  if (isUpdatePlanTool(toolName)) {
    return await completeUpdatePlanPath(input, toolInput, parsed)
  }

  const invalidInput = validateNativeTaskUpdateInput(toolInput)
  if (invalidInput) return invalidInput

  return await completeNativeTaskUpdatePath(input, parsed)
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
  if (isTaskSubjectWorkDeferral(subject)) {
    return preToolUseDeny(
      `Deferral tactic detected: task subject "${subject}" uses deferral framing. ` +
        "All work is to be completed in this session. There is no follow-up session. " +
        "Replace it with concrete current-session work, start it now, or record a real blocker with evidence."
    )
  }
  const duplicateOutcome = await checkTaskCreateSubjectGovernance(input, subject)
  if (duplicateOutcome) return duplicateOutcome

  const result = detect(subject)
  if (result.matched) {
    if (await sessionHasHealthyPendingTaskBuffer(input)) return allowCompoundSubjectWithBuffer()
    return preToolUseDeny(formatMessage(result))
  }
  return preToolUseAllow()
}

async function evaluateBlockedToolCliInput(
  input: Record<string, any>,
  parsed: ParsedGovernanceInput
): Promise<SwizHookOutput | null> {
  if (!shouldInspectShellInput(parsed)) return null

  const cliResult = await runSwizTasksEnforcement(input)
  if (!cliResult || Object.keys(cliResult).length === 0) return null
  const hookOutput = (cliResult as Record<string, any>).hookSpecificOutput as
    | Record<string, any>
    | undefined
  return hookOutput?.permissionDecision === "deny" ? cliResult : null
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
  if (!(await isTaskEnforcementProject(input, cwd))) return {}

  const transcriptPath: string = (input.transcript_path as string) ?? ""

  const taskFileAccess = evaluateTaskFileAccess(input, toolName, sessionId ?? undefined)
  if (taskFileAccess) return taskFileAccess

  const cliDenied = await evaluateBlockedToolCliInput(input, parsed)
  if (cliDenied) return cliDenied

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

async function dispatchTaskGovernancePath(
  input: Record<string, any>,
  parsed: ParsedGovernanceInput,
  toolName: string,
  toolInput: Record<string, any>
): Promise<SwizHookOutput> {
  if (isNativeTaskTool(toolName)) {
    return await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
  }
  if (isTaskCreateTool(toolName)) return await evaluateTaskCreatePath(input, toolInput)
  if (isBlockedTool(toolName)) return await evaluateBlockedToolPath(input, parsed, toolName)
  return await evaluateOtherShellToolPath(input, parsed)
}

async function evaluatePretooluseTaskGovernance(rawInput: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(rawInput)
  const input = parsed as unknown as Record<string, any>
  const toolName = String(input.tool_name ?? "")
  const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

  const blockedTaskFiles = evaluateBlockedTaskFilesPrecheck(input, toolName, toolInput)
  if (blockedTaskFiles) return blockedTaskFiles

  // Codex can use update_plan, but its tools do not depend on task state.
  // Keep the task-file integrity precheck above while bypassing workflow gates.
  if (isCodexTaskGovernanceExempt(input)) return {}

  if (!hasTaskGovernanceSurface(input, toolName)) return {}

  // Fully relax workflow-governance blocks for a short window after a user message.
  // The task-file integrity precheck above still applies; only the buffer/staleness/
  // rate-limit/minimums pressure is suspended so a fresh request can be acted on at once.
  if (await isWithinUserMessageGrace(input)) return {}

  const overflow = await evaluatePendingOverflowGuard(input, toolName)
  if (overflow) return overflow

  return await dispatchTaskGovernancePath(input, parsed, toolName, toolInput)
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
  const allTasks = overlayEventState(await readTasksForInput(input, sessionId), sessionId)
  let pending = 0
  let inProgress = 0
  for (const t of allTasks) {
    if (t.status === "pending") pending++
    else if (t.status === "in_progress") inProgress++
  }
  return { allTasks, pending, inProgress, total: allTasks.length }
}

type TaskTraceCounts = Awaited<ReturnType<typeof readTaskCountsForTrace>>

async function buildLowPendingTrace(
  input: Record<string, any>,
  stateLead: string,
  pending: number,
  deferralContext: string | null
): Promise<string> {
  const hints = await fetchIssueHints(input.cwd as string | undefined)
  const hintSuffix =
    !deferralContext && hints.length > 0 ? ` Open issues to consider: ${hints.join("; ")}.` : ""
  const bufferMessage =
    pending === 0
      ? `${stateLead} What should we do next? Add a pending task to keep the planning buffer stable.`
      : `${stateLead} What should we do next? Add one more pending task to keep the buffer stable.`
  return withDeferralTaskContext(
    replaceTaskGovernanceSynonyms(`${bufferMessage}${hintSuffix}`),
    deferralContext
  )
}

async function formatTaskTraceContext(
  input: Record<string, any>,
  counts: TaskTraceCounts
): Promise<string> {
  // No native task tools: the queue can never fill, so nagging about it is pure noise.
  if (await nativeTaskToolsProvenAbsent(input)) return ""

  // A skill is driving: the state gates have stood down, so the advisory that prescribes the same
  // remedy is noise attached to every tool result for the skill's duration.
  if (await hasActiveSkillForHookPayload(input)) return ""

  const stateLead = formatTaskStateLead({
    total: counts.total,
    incomplete: counts.pending + counts.inProgress,
    pending: counts.pending,
    inProgress: counts.inProgress,
  })
  const deferralContext = buildDeferralTaskContext(counts.allTasks)

  if (counts.total === 0 || (counts.pending === 0 && counts.inProgress === 0)) {
    return withDeferralTaskContext(
      replaceTaskGovernanceSynonyms(
        `${stateLead} What are we working on? Create tasks before starting implementation.`
      ),
      deferralContext
    )
  }
  if (counts.inProgress === 0) {
    return withDeferralTaskContext(
      replaceTaskGovernanceSynonyms(
        `${stateLead} What are we currently working on? Claim a pending task with TaskUpdate before starting.`
      ),
      deferralContext
    )
  }
  if (counts.pending <= 1) {
    return await buildLowPendingTrace(input, stateLead, counts.pending, deferralContext)
  }
  return withDeferralTaskContext(
    replaceTaskGovernanceSynonyms(`${stateLead} On track — good task hygiene.`),
    deferralContext
  )
}

async function buildTraceContext(rawInput: unknown): Promise<string> {
  try {
    const input = rawInput as Record<string, any>
    const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
    return await formatTaskTraceContext(input, await readTaskCountsForTrace(sessionId, input))
  } catch (err) {
    return `Task state unavailable: ${(err as Error)?.message ?? err}`
  }
}

export const COMPLIANCE_SUPPRESS_THRESHOLD_MS = 30_000

/** Pure check: returns true when the given entry represents 30+ seconds of healthy compliance. */
export function isComplianceSuppressible(
  entry: { state: string; at: number } | null,
  now = Date.now()
): boolean {
  if (!entry || entry.state !== "healthy") return false
  return now - entry.at >= COMPLIANCE_SUPPRESS_THRESHOLD_MS
}

export async function shouldSuppressGovernanceTrace(input: Record<string, any>): Promise<boolean> {
  const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
  if (!sessionId) return false
  try {
    const entry = await getCurrentComplianceEntry(sessionId)
    if (entry && entry.state === "healthy") {
      const toolName = (input?.tool_name as string) ?? ""
      if (isCodeChangeTool(toolName) || isTaskUpdateTool(toolName)) {
        return true
      }
    }
    return isComplianceSuppressible(entry)
  } catch {
    return false
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
      if (isCodexTaskGovernanceExempt(input as Record<string, any>)) return {}
      if (await shouldSuppressGovernanceTrace(input as Record<string, any>)) return {}
      const trace = await buildTraceContext(input)
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
