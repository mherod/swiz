#!/usr/bin/env bun

// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless:
//   1. The session has at least two incomplete tasks (pending or in_progress)
//   2. At least one incomplete task is pending to represent the next intended step
//   3. Tasks haven't gone stale (no task tool interaction in last STALENESS_THRESHOLD calls)

import { formatDuration } from "../src/format-duration.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import {
  allowPreToolUse,
  allowPreToolUseWithContext,
  denyPreToolUse,
  findPriorSessionTasks,
  formatActionPlan,
  formatTaskCompleteCommands,
  formatTaskList,
  formatTaskSubjectsForDisplay,
  getCurrentSessionTaskToolStats,
  hasFileInTree,
  isEditTool,
  isGitRepo,
  isIncompleteTaskStatus,
  isShellTool,
  isTaskTrackingExemptShellCommand,
  isTerminalTaskStatus,
  isWriteTool,
  mergeActionPlanIntoTasks,
  readSessionTasks,
  resolveSafeSessionId,
  scheduleAutoSteer,
} from "./utils/hook-utils.ts"

// ── Auto-steer deny wrapper ────────────────────────────────────────────────
// When auto-steer is available, schedule the denial reason as a steering
// message and ALLOW the tool call — the guidance will be typed into the
// terminal on the next PostToolUse cycle. When unavailable, deny as before.
let _autoSteerSessionId: string | null = null
let _cwd: string | undefined

async function deny(reason: string): Promise<never> {
  if (_autoSteerSessionId) {
    if (await scheduleAutoSteer(_autoSteerSessionId, reason, undefined, _cwd)) {
      // Auto-steer will deliver the message — allow silently to avoid duplicate guidance.
      allowPreToolUse("")
    }
  }
  denyPreToolUse(reason)
}

async function denyRequiredTasks(reason: string): Promise<never> {
  // Required-task enforcement must hard-block immediately.
  denyPreToolUse(reason)
}

const STALENESS_THRESHOLD = 20
const LARGE_CONTENT_LINE_THRESHOLD = 10
const IN_PROGRESS_CAP = 4

// Governance thresholds adjusted by auditStrictness setting
const GOVERNANCE_THRESHOLDS = {
  strict: { minIncomplete: 2, minPending: 1 },
  relaxed: { minIncomplete: 1, minPending: 0 },
  "local-dev": { minIncomplete: 1, minPending: 0 },
} as const

interface GovernanceThresholds {
  minIncomplete: number
  minPending: number
}

function resolveGovernanceThresholds(auditStrictness: string): GovernanceThresholds {
  const mode = auditStrictness as keyof typeof GOVERNANCE_THRESHOLDS
  return GOVERNANCE_THRESHOLDS[mode] ?? GOVERNANCE_THRESHOLDS.strict
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
export function isLargeContentPayload(input: Record<string, unknown>): boolean {
  const toolInput = input?.tool_input as Record<string, unknown> | undefined
  const content = ((toolInput?.new_string ?? toolInput?.content) as string) ?? ""
  return content.split("\n").length >= LARGE_CONTENT_LINE_THRESHOLD
}

async function isTaskEnforcementProject(cwd: string): Promise<boolean> {
  if (!(await isGitRepo(cwd))) return false
  return hasFileInTree(cwd, "CLAUDE.md")
}

function isBlockedTool(toolName: string): boolean {
  return isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName)
}

function isMemoryMarkdownEdit(input: Record<string, unknown>, toolName: string): boolean {
  if (!isEditTool(toolName) && !isWriteTool(toolName)) return false
  const filePath = String(
    (input.tool_input as Record<string, unknown> | undefined)?.file_path ?? ""
  )
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
): (allTasks: Array<{ id: string; status: string; subject: string }>) => Promise<void> {
  return async (allTasks) => {
    if (allTasks.length !== 0) return
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
      await denyRequiredTasks(
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

    await denyRequiredTasks(
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

async function checkTaskMinimums(
  toolName: string,
  summary: ReturnType<typeof buildIncompleteTaskSummary>,
  thresholds: GovernanceThresholds
): Promise<void> {
  const { incompleteTasks, pendingTasks, allTasksDone, incompleteTaskList } = summary
  if (allTasksDone) return
  if (
    incompleteTasks.length >= thresholds.minIncomplete &&
    pendingTasks.length >= thresholds.minPending
  )
    return

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

  await denyRequiredTasks(
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
  allTasks: Array<{ id: string; status: string; subject: string }>
): Promise<void> {
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress")
  if (inProgressTasks.length <= IN_PROGRESS_CAP) return
  const taskList = inProgressTasks.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  await deny(
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
  incompleteTasks: Array<{ id: string; status: string; subject: string }>
): Promise<void> {
  const mergePrTasks = incompleteTasks.filter((t) => DIRECT_MERGE_INTENT_RE.test(t.subject))
  if (mergePrTasks.length === 0) return
  try {
    const settings = await readSwizSettings()
    if (!settings.strictNoDirectMain) return
    const taskList = mergePrTasks.map((t) => `  • #${t.id} (${t.status}): ${t.subject}`).join("\n")
    await deny(
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
    // Settings read failure → fail-open; other checks still apply.
  }
}

interface CheckTaskStalenessOpts {
  toolName: string
  input: Record<string, unknown>
  transcriptPath: string
  allTasks: Array<{ id: string; status: string; subject: string }>
  activeTasks: string[]
  allTasksDone: boolean
  cwd: string
}

function shouldSkipStalenessCheck(opts: {
  transcriptPath: string
  lastTaskIndex: number
  allTasksDone: boolean
  callsSinceTask: number
  toolName: string
  input: Record<string, unknown>
  hasInProgressTask: boolean
}): boolean {
  if (!opts.transcriptPath) return true
  if (opts.lastTaskIndex < 0 || opts.allTasksDone) return true
  if (opts.callsSinceTask < STALENESS_THRESHOLD) return true
  if (opts.hasInProgressTask) return true
  if (
    (isEditTool(opts.toolName) || isWriteTool(opts.toolName)) &&
    isLargeContentPayload(opts.input)
  )
    return true
  return false
}

async function checkTaskStaleness(opts: CheckTaskStalenessOpts): Promise<void> {
  const { toolName, input, transcriptPath, allTasks, activeTasks, allTasksDone, cwd } = opts
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
    return

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
  const sessionId = (input as Record<string, unknown>).session_id as string | undefined
  if (sessionId) await mergeActionPlanIntoTasks(stalePlanSteps, sessionId, cwd)
  await deny(
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
): Promise<void> {
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
      allowPreToolUseWithContext(slowTaskWarning, slowTaskWarning)
    }
  } catch {
    // Settings lookup failures should never block or crash the tool call.
  }
}

interface ParsedInput {
  input: Record<string, unknown>
  toolName: string
  sessionId: string
  transcriptPath: string
  cwd: string
}

function isExemptToolCall(input: Record<string, unknown>, toolName: string): boolean {
  if (isShellTool(toolName)) {
    const toolInput = input?.tool_input as Record<string, unknown> | undefined
    const command = String(toolInput?.command ?? "")
    if (isTaskTrackingExemptShellCommand(command)) return true
  }
  return isMemoryMarkdownEdit(input, toolName)
}

function validateGuardConditions(
  sessionId: string | null | undefined,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  if (!sessionId || !isBlockedTool(toolName) || !getHomeDirOrNull()) return false
  if (isExemptToolCall(input, toolName)) return false
  return true
}

function applySyncGuards(input: Record<string, unknown>): ParsedInput | null {
  const toolName: string = (input?.tool_name as string) ?? ""
  const sessionId = resolveSafeSessionId(input?.session_id as string | undefined)
  const transcriptPath: string = (input?.transcript_path as string) ?? ""
  const cwd: string = (input?.cwd as string) ?? process.cwd()

  if (!validateGuardConditions(sessionId, toolName, input)) return null

  return { input, toolName, sessionId: sessionId as string, transcriptPath, cwd }
}

async function parseAndGuard(): Promise<ParsedInput | null> {
  const input = await Bun.stdin.json()
  const parsed = applySyncGuards(input)
  if (!parsed) return null
  if (!(await isTaskEnforcementProject(parsed.cwd))) return null
  return parsed
}

async function runChecks(parsed: ParsedInput): Promise<void> {
  const { input, toolName, sessionId, transcriptPath, cwd } = parsed

  // Enable auto-steer: if the setting is on, deny() will schedule a
  // steering message and allow the tool call instead of hard-blocking.
  _autoSteerSessionId = sessionId
  _cwd = cwd

  // Resolve governance thresholds from effective settings
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

  const allTasks = await readSessionTasks(sessionId)
  const activeTasks = allTasks
    .filter((t) => isIncompleteTaskStatus(t.status))
    .map((t) => `#${t.id} (${t.status}): ${t.subject}`)

  await checkNoTasks(toolName, cwd, sessionId, thresholds)(allTasks)

  const summary = buildIncompleteTaskSummary(allTasks)
  await checkTaskMinimums(toolName, summary, thresholds)
  await checkInProgressCap(toolName, allTasks)
  await checkDirectMergeIntent(toolName, summary.incompleteTasks)
  await checkTaskStaleness({
    toolName,
    input,
    transcriptPath,
    allTasks,
    activeTasks,
    allTasksDone: summary.allTasksDone,
    cwd,
  })
  await emitSlowTaskWarning(allTasks, sessionId, cwd)
}

async function main() {
  const parsed = await parseAndGuard()
  if (!parsed) process.exit(0)
  await runChecks(parsed)
  process.exit(0)
}

if (import.meta.main) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    denyPreToolUse(
      `STOP. ${"\u26a0\ufe0f"} pretooluse-require-tasks encountered an unexpected error and is failing closed.\n\n` +
        `Error: ${message}\n\n` +
        formatActionPlan(
          [
            "Check that the hook file and its dependencies are intact.",
            "If the error persists, inspect the hook source at hooks/pretooluse-require-tasks.ts.",
          ],
          { translateToolNames: true }
        )
    )
  })
}
