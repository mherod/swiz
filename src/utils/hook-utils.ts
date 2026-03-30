// Shared utilities for swiz hook scripts.
// Import with: import { denyPreToolUse, allowPreToolUseWithUpdatedInput, isShellTool, isEditTool, ... } from "./hook-utils.ts";
// noinspection JSUnusedGlobalSymbols

import { dirname, join } from "node:path"
import {
  type HookOutput,
  hookOutputSchema,
  type SessionHookInput,
  type ToolHookInput,
} from "../../hooks/schemas.ts"
import {
  type ActionPlanItem,
  expandSkillReferences,
  formatActionPlan,
  mergeActionPlanIntoTasks,
} from "../action-plan.ts"
import { stderrLog } from "../debug.ts"
import {
  detectForkTopology,
  getOpenPrForBranch,
  getRepoSlug,
  getUpstreamSlug,
  gh,
  ghJsonViaDaemon,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "../git-helpers.ts"
import { getHomeDirOrNull } from "../home.ts"
import { isInlineSwizHookRun, SwizHookExit } from "../inline-hook-context.ts"
import { buildContextHookOutput, type SwizHookOutput } from "../SwizHook.ts"
import { skillAdvice, skillExists } from "../skill-utils.ts"
import { sessionTaskSentinelPath } from "../temp-paths.ts"
import {
  GH_CMD_RE,
  GIT_READ_RE,
  GIT_WRITE_RE,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  SETUP_CMD_RE,
} from "./git-utils.ts"
import { messageFromUnknownError } from "./hook-json-helpers.ts"
import { SWIZ_CMD_RE } from "./inline-hook-helpers.ts"

export type { SessionHookInput, ToolHookInput }

// ─── Runtime dependency check ───────────────────────────────────────────────
// Verify bun is reachable on PATH. This file executes inside bun, but the
// check catches mangled PATH in non-interactive agent shells where the user's
// profile wasn't sourced. Uses Bun.which() for a fast lookup (no spawn).

if (!Bun.which("bun")) {
  stderrLog(
    "bun PATH check",
    "swiz: bun is not reachable on PATH in this shell environment. " +
      "Hooks that invoke bun scripts will fail. " +
      "Ensure bun is installed: curl -fsSL https://bun.sh/install | bash"
  )
}

// ─── Project convention detection ───────────────────────────────────────────
// Walk up from CWD looking for lockfiles to determine the project's package
// manager and runtime. Cached per process so hooks don't stat the filesystem
// on every import.

export { skillAdvice, skillExists }
export {
  detectCurrentAgent,
  isCurrentAgent,
  isRunningInAgent,
  toolNameForCurrentAgent,
} from "../agent-paths.ts"

export { getCanonicalPathHash } from "../git-helpers.ts"
export { resolveSafeSessionId, sanitizeSessionId, sessionPrefix } from "../session-id.ts"

export type { PackageManager, Runtime } from "./package-detection.ts"

export {
  detectPackageManager,
  detectPkgRunner,
  detectRuntime,
} from "./package-detection.ts"

// ─── Terminal & shell detection ───────────────────────────────────────────
// Re-exported so hook scripts can detect the hosting terminal and shell
// via the single hook-utils.ts import.

export type {
  EnvironmentInfo,
  ShellInfo,
  ShellType,
  TerminalApp,
  TerminalInfo,
} from "./terminal-detection.ts"
export { detectEnvironment, detectShell, detectTerminal } from "./terminal-detection.ts"

// ─── Framework detection ──────────────────────────────────────────────────
// Re-exported from src/detect-frameworks.ts so hook scripts can access it
// via the single hook-utils.ts import, and so src/manifest.ts can import
// directly from src/ without creating a src→hooks dependency.

export type { Framework, ProjectStack } from "../detect-frameworks.ts"
export {
  clearFrameworkCache,
  detectFrameworks,
  detectProjectStack,
} from "../detect-frameworks.ts"

// ─── Cross-agent tool equivalence ──────────────────────────────────────────
// Each set contains all names an agent might use for the same concept.
// Claude Code | Cursor       | Gemini CLI        | Codex CLI
// Re-exported from src/tool-matchers.ts so hook scripts keep using the
// single hook-utils.ts import, while src/ modules can import directly
// without reaching into hooks/.
export {
  EDIT_TOOLS,
  isCodeChangeTool,
  isEditTool,
  isFileEditTool,
  isNotebookTool,
  isShellTool,
  isTaskCreateTool,
  isTaskGetTool,
  isTaskListTool,
  isTaskTool,
  isTaskUpdateTool,
  isWriteTool,
  NOTEBOOK_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  TASK_CREATE_TOOLS,
  TASK_GET_TOOLS,
  TASK_LIST_TOOLS,
  TASK_TOOLS,
  TASK_UPDATE_TOOLS,
  WRITE_TOOLS,
} from "../tool-matchers.ts"

// ─── Subprocess timeout enforcement ─────────────────────────────────────────
// Hooks that spawn subprocesses (lint, typecheck, prettier, git, gh, etc.)
// must use this utility to prevent hangs. SIGTERM is sent on timeout,
// escalated to SIGKILL after a grace period.

// ─── Projected content computation ──────────────────────────────────────────
// Canonical implementations live in edit-projection.ts (extracted to avoid
// circular deps when inline SwizHook files import these via manifest.ts).
// Re-exported here for backward-compatible access via hook-utils.ts.
export { computeProjectedContent, type ProjectedContentInput } from "./edit-projection.ts"

// isSwizCommand, PLACEHOLDER_SUBJECT_RE, isPlaceholderSubject live in inline-hook-helpers.ts
// Re-exported here for backwards compatibility with existing consumers.
export {
  isPlaceholderSubject,
  isSwizCommand,
  PLACEHOLDER_SUBJECT_RE,
} from "./inline-hook-helpers.ts"

// ─── Hook response helpers ─────────────────────────────────────────────────
// Outputs polyglot JSON understood by Claude Code, Cursor, Gemini CLI, and Codex CLI.

/** PreToolUse spinner / `suppressOutput` preview — keep short. */
const PREVIEW_LEN_PRE_TOOL = 70
/**
 * Stop / PostToolUse block: `systemMessage` is a first-line preview; full text stays in `reason`.
 * Cursor and other UIs surface `systemMessage` prominently — 70 chars looked like junk truncation.
 */
const PREVIEW_LEN_BLOCK = 4000

/** Extract the first line of a multi-line message, optionally capped for UI previews. */
function extractFirstLine(text: string, maxLen = PREVIEW_LEN_PRE_TOOL): string {
  const line = text.split("\n").shift()?.trim() || ""
  if (maxLen <= 0) return line
  return line.length > maxLen ? `${line.slice(0, maxLen - 3).trimEnd()}...` : line
}

function denyPreToolUseObj(reason: string, options: ActionRequiredOptions) {
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractFirstLine(reason),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason + preToolActionRequired(reason, options),
    },
  })
}

/** Emit a PreToolUse denial and exit. Appends ACTION REQUIRED footer. Works across all agents. */
export function denyPreToolUse(reason: string, options: ActionRequiredOptions = {}): never {
  exitWithHookObject(denyPreToolUseObj(reason, options))
}

function allowPreToolUseObj(reason: string): HookOutput {
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractFirstLine(reason),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  })
}

/** Emit a PreToolUse allow with advisory context and exit. Does NOT block. Works across all agents. */
export function allowPreToolUse(reason: string): never {
  exitWithHookObject(allowPreToolUseObj(reason))
}

function allowPreToolUseWithContextObj(
  additionalContext: string,
  effectiveReason: string
): HookOutput {
  return hookOutputSchema.parse({
    suppressOutput: true,
    ...(additionalContext && { systemMessage: additionalContext }),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(effectiveReason && { permissionDecisionReason: effectiveReason }),
      ...(additionalContext && { additionalContext }),
    },
  })
}

/** Emit a PreToolUse allow with both a visible hint and additionalContext. */
export function allowPreToolUseWithContext(reason: string, additionalContext: string): never {
  const effectiveReason = reason || additionalContext
  exitWithHookObject(allowPreToolUseWithContextObj(additionalContext, effectiveReason))
}

function allowPreToolUseWithUpdatedInputObj(
  updatedInput: Record<string, unknown>,
  reason?: string
): HookOutput {
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractFirstLine(reason ?? ""),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(reason && { permissionDecisionReason: reason }),
      updatedInput,
      modifiedInput: updatedInput,
    },
  })
}

/** Emit a PreToolUse allow with modified tool input and exit. Works across all agents. */
export function allowPreToolUseWithUpdatedInput(
  updatedInput: Record<string, unknown>,
  reason?: string
): never {
  exitWithHookObject(allowPreToolUseWithUpdatedInputObj(updatedInput, reason))
}

// ── SwizHook inline output builders (return objects, do not exit) ─────────────
// These mirror the above helpers but return HookOutput directly for use in
// SwizHook.run() implementations. They enable inline hooks to participate in
// cooldown tracking and multi-hook result merging.

/** Build a PreToolUse allow response (mirrors `allowPreToolUse`). */
export function preToolUseAllow(reason = ""): SwizHookOutput {
  return {
    suppressOutput: true,
    systemMessage: extractFirstLine(reason),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow" as const,
      permissionDecisionReason: reason,
    },
  }
}

const PRE_TOOL_ACTION_REQUIRED =
  "\n\nACTION REQUIRED: Fix the underlying issue before retrying. Do not attempt to bypass or work around it — address the root cause."

/** Build a PreToolUse deny response (mirrors `denyPreToolUse`). Appends ACTION REQUIRED footer. */
export function preToolUseDeny(reason: string): SwizHookOutput {
  const fullReason = reason + PRE_TOOL_ACTION_REQUIRED
  return {
    suppressOutput: true,
    systemMessage: extractFirstLine(reason) || "Denied without reason",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny" as const,
      permissionDecisionReason: fullReason,
    },
  }
}

/** Build a PreToolUse allow with advisory `additionalContext` (mirrors `allowPreToolUseWithContext`). */
export function preToolUseAllowWithContext(
  reason: string,
  additionalContext: string
): SwizHookOutput {
  const effectiveReason = reason || additionalContext
  return {
    suppressOutput: true,
    ...(additionalContext && { systemMessage: additionalContext }),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow" as const,
      ...(effectiveReason && { permissionDecisionReason: effectiveReason }),
      ...(additionalContext && { additionalContext }),
    },
  }
}

/**
 * Factory for file-path guard PreToolUse hooks.
 *
 * Returns an async `main()` that parses stdin, tests the file path against
 * `predicate`, and calls `denyPreToolUse` / `allowPreToolUse` accordingly.
 * Absorbs the boilerplate shared by lockfile, node_modules, and similar guards.
 */
/**
 * Check whether a hook input represents an Edit/Write operation targeting a file
 * whose path ends with the given suffix. Shared predicate for file-path guards.
 */
export { isFileEditForPath } from "./edit-projection.ts"

export function filePathGuardHook(
  predicate: (filePath: string) => boolean,
  denyReason: string,
  allowMsg?: string | ((filePath: string) => string)
): () => Promise<void> {
  return async (): Promise<void> => {
    // Load input schema dynamically to avoid circular dependencies
    const { fileEditHookInputSchema } = await import("../../hooks/schemas.ts")
    const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
    const filePath = input.tool_input?.file_path ?? ""

    // If the file matches the deny predicate, block immediately
    if (predicate(filePath)) {
      denyPreToolUse(denyReason)
    }

    // Resolve the allow message (function -> result, string -> direct, undefined -> empty)
    const message = typeof allowMsg === "function" ? allowMsg(filePath) : (allowMsg ?? "")
    allowPreToolUse(message)
  }
}

function denyPostToolUseObj(reason: string): HookOutput {
  return hookOutputSchema.parse({
    decision: "block",
    reason,
    suppressOutput: true,
    systemMessage: extractFirstLine(reason, PREVIEW_LEN_BLOCK),
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  })
}

/** PostToolUse block payload without stdout/exit — use from `SwizHook.run()`. */
export function buildDenyPostToolUseOutput(reason: string): HookOutput {
  return denyPostToolUseObj(reason)
}

export function exitWithHookObject(obj: HookOutput): never {
  if (isInlineSwizHookRun()) {
    throw new SwizHookExit(obj)
  }
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(0)
}

/** Emit a PostToolUse block decision and exit. Works across all agents. */
export function denyPostToolUse(reason: string): never {
  exitWithHookObject(buildDenyPostToolUseOutput(reason))
}

export { buildContextHookOutput }

/**
 * Emit additional context for a hook event. **Subprocess-only:** calls `process.exit(0)`.
 * From `SwizHook.run()` (inline dispatch), return {@link buildContextHookOutput} instead
 * so the dispatcher can record cooldowns and merge results with other hooks.
 */
export function emitContext(eventName: string, context: string): never {
  exitWithHookObject(buildContextHookOutput(eventName, context))
}

export { SwizHookExit } from "../inline-hook-context.ts"

// ─── Stop hook helpers ────────────────────────────────────────────────────

export { type ActionPlanItem, expandSkillReferences, formatActionPlan, mergeActionPlanIntoTasks }

function summarizeUpdateMemoryCause(reason: string): string {
  const firstParagraph = reason
    .replace(/\r/g, "")
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim()

  const cleaned = (firstParagraph ?? "")
    .replace(/^STOP\.\s*/i, "")
    .replace(/^ACTION REQUIRED:\s*/i, "")
    .trim()

  if (!cleaned) {
    return "A required workflow step or explicit instruction was not followed."
  }

  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}...` : cleaned
}

function describeUpdateMemoryCause(reason: string): string {
  const summary = summarizeUpdateMemoryCause(reason)
  if (/\b(user|instruction|requested|asked|told)\b/i.test(reason)) {
    return `A user instruction was missed: ${summary}`
  }
  return `A hook detected missing or unstructured workflow behavior: ${summary}`
}

function updateMemoryAdvice(reason: string): string {
  const cause = describeUpdateMemoryCause(reason)
  return skillAdvice(
    "update-memory",
    `Use the /update-memory skill to record a DO or DON'T rule that proactively builds the required steps into your standard development workflow. Cause to capture: ${cause}`,
    `Update your MEMORY.md with a DO or DON'T rule that proactively builds the required steps into your standard development workflow. Cause to capture: ${cause}`
  )
}

function isUpdateMemoryFooterEnabled(): boolean {
  return true
}

interface ActionRequiredOptions {
  includeUpdateMemoryAdvice?: boolean
}

function memoryAdvice(include: boolean, reason: string): string {
  if (!include || !isUpdateMemoryFooterEnabled()) return ""
  return `\n\n${updateMemoryAdvice(reason)}`
}

/** Standard ACTION REQUIRED footer for PreToolUse denials. */
export function preToolActionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: Fix the underlying issue before retrying. Do not attempt to bypass or work around it — address the root cause.${memory}`
}

/** Standard ACTION REQUIRED footer appended to all stop hook block reasons. */
export function actionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: You must act on this now. Do not try to stop again without completing the required action.${memory}`
}

export function blockStopObj(
  reason: string,
  options: { includeUpdateMemoryAdvice?: boolean } = {}
): HookOutput {
  const preview = extractFirstLine(reason, PREVIEW_LEN_BLOCK)
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason: reason + actionRequired(reason, options),
    suppressOutput: true,
    systemMessage: preview,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: preview,
    },
  })
}

/** Emit a stop block decision and exit. Appends ACTION_REQUIRED footer. */
export function blockStop(
  reason: string,
  options: { includeUpdateMemoryAdvice?: boolean } = {}
): never {
  exitWithHookObject(blockStopObj(reason, options))
}

function blockStopRawObj(reason: string) {
  const preview = extractFirstLine(reason, PREVIEW_LEN_BLOCK)
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason,
    suppressOutput: true,
    systemMessage: preview,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: preview,
    },
  })
}

/** Emit a raw stop block (no footer appended — caller controls the full reason). */
export function blockStopRaw(reason: string): never {
  exitWithHookObject(blockStopRawObj(reason))
}

/** Inline SwizHook equivalent of {@link blockStopHumanRequired}. */
export function blockStopHumanRequiredObj(reason: string): HookOutput {
  const fullReason = `${reason}\n\nACTION REQUIRED: Resolve this block before stopping.`
  const preview = extractFirstLine(reason, PREVIEW_LEN_BLOCK)
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason: fullReason,
    resolution: "human-required",
    suppressOutput: true,
    systemMessage: preview,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: preview,
    },
  })
}

/**
 * Emit a stop block that requires human action to resolve.
 * Adds `resolution: "human-required"` to the output so the agent understands
 * it cannot resolve the block autonomously — a human must intervene.
 * Appends a note to the reason explaining this.
 */
export function blockStopHumanRequired(reason: string): never {
  exitWithHookObject(blockStopHumanRequiredObj(reason))
}

// ─── Follow-up issue filing ─────────────────────────────────────────────
// Stop hooks can file follow-up issues for findings that represent new work
// (not incomplete current work). This allows the session to stop cleanly
// while capturing the finding as a tracked issue.

export interface FollowUpIssueOptions {
  /** Issue title (required) */
  title: string
  /** Issue body / description */
  body: string
  /** Labels to apply (defaults to ["backlog", "enhancement"]) */
  labels?: string[]
  /** Working directory for gh CLI */
  cwd: string
  /** Session ID for reference in the issue body */
  sessionId?: string | null
}

export type FileFollowUpIssueResult =
  | { status: "blocked"; output: HookOutput }
  | { status: "filed"; issueNum: number | null }

/**
 * Try to file a follow-up GitHub issue. Returns a structured result so SwizHook
 * `run()` can return `output` without `process.exit`; subprocess callers use
 * {@link fileFollowUpIssue} which applies `exitWithHookObject` / `blockStop`.
 */
export async function tryFileFollowUpIssue(
  options: FollowUpIssueOptions,
  blockReason: string
): Promise<FileFollowUpIssueResult> {
  const { title, body, labels = ["backlog", "enhancement"], cwd, sessionId } = options

  if (!hasGhCli()) {
    return {
      status: "blocked",
      output: blockStopObj(
        `${blockReason}\n\n(Could not auto-file follow-up issue: gh CLI unavailable)`,
        { includeUpdateMemoryAdvice: false }
      ),
    }
  }

  const commitSha = await git(["rev-parse", "--short", "HEAD"], cwd)
  const contextLines = [body, "", "---", `Filed automatically by stop hook.`]
  if (commitSha) contextLines.push(`Commit: ${commitSha}`)
  if (sessionId) contextLines.push(`Session: ${sessionId.slice(0, 12)}`)

  const bodyFile = `/tmp/swiz-follow-up-${Date.now()}.md`
  await Bun.write(bodyFile, contextLines.join("\n"))

  try {
    const labelArgs = labels.flatMap((l) => ["--label", l])
    const output = await gh(
      ["issue", "create", "--title", title, "--body-file", bodyFile, ...labelArgs],
      cwd
    )

    const match = output.match(/\/issues\/(\d+)/)
    const issueNum = match?.[1] ? Number.parseInt(match[1], 10) : null

    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }

    return { status: "filed", issueNum }
  } catch {
    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }
    return {
      status: "blocked",
      output: blockStopObj(`${blockReason}\n\n(Failed to auto-file follow-up issue)`, {
        includeUpdateMemoryAdvice: false,
      }),
    }
  }
}

/**
 * File a GitHub issue for a follow-up finding and allow stop.
 * Returns the created issue number on success, or null if filing failed.
 * On failure, falls back to blocking stop so the finding is not lost.
 */
export async function fileFollowUpIssue(
  options: FollowUpIssueOptions,
  blockReason: string
): Promise<number | null> {
  const r = await tryFileFollowUpIssue(options, blockReason)
  if (r.status === "blocked") {
    exitWithHookObject(r.output)
  }
  return r.issueNum
}

// ─── Git / CLI helpers ──────────────────────────────────────────────────
// Canonical definitions live in src/git-helpers.ts. Imported here so
// internal callers within hook-utils can reference them, and re-exported
// so all hook scripts can keep importing from "./hook-utils.ts" unchanged.

/**
 * Hooks should prefer daemon-backed gh query caching to reduce API pressure.
 * Falls back to direct gh + local TTL cache when daemon is unavailable.
 */
async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
  return ghJsonViaDaemon<T>(args, cwd, { ttlMs: 300_000 })
}

export {
  detectForkTopology,
  getOpenPrForBranch,
  getRepoSlug,
  getUpstreamSlug,
  gh,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
}

// ─── Issue guidance consolidation ──────────────────────────────────────────
export { buildIssueGuidance } from "./inline-hook-helpers.ts"

// ─── Session task I/O ────────────────────────────────────────────────────────

// ─── Subject fingerprinting (re-exported from src/) ─────────────────────
export {
  computeSubjectFingerprint,
  normalizeSubject,
  significantWords,
  stemWord,
  subjectsOverlap,
} from "../subject-fingerprint.ts"

/**
 * Walk upward from `startDir` to the filesystem root looking for `fileName`.
 * Returns true on first match, false when no match exists.
 */
export async function hasFileInTree(startDir: string, fileName: string): Promise<boolean> {
  if (!startDir || !fileName) return false
  let dir = startDir
  while (true) {
    if (await Bun.file(join(dir, fileName)).exists()) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Apply the pending → in_progress auto-transition before completing a task object.
 * Mutates the task in place. Use when bypassing the full updateStatus service (e.g., direct file writes in hooks).
 * When `enabled` is false, the auto-transition is skipped — callers must transition explicitly.
 */
export function autoTransitionForComplete(task: { status: string }, enabled = true): void {
  if (enabled && task.status === "pending") task.status = "in_progress"
}

/**
 * Build the standard denial message for the last-task-standing guard.
 * Both pretooluse-enforce-taskupdate and pretooluse-require-task-evidence use this.
 */
/** Filler suggestions for the next logical step when all tasks are about to complete. */
const NEXT_STEP_SUGGESTIONS = [
  "Review and address open GitHub issues",
  "Run quality checks and fix any warnings",
  "Verify recent changes work end-to-end",
  "Check for TODOs or FIXMEs in recently edited files",
  "Update documentation to reflect recent changes",
]

export function buildLastTaskStandingDenial(taskId: string): string {
  const suggestion = NEXT_STEP_SUGGESTIONS[Math.floor(Math.random() * NEXT_STEP_SUGGESTIONS.length)]
  return (
    `STOP. Completing task #${taskId} would leave zero incomplete tasks.\n\n` +
    `You have executive authority to determine the next logical step. ` +
    `Before completing this task, plan your next steps:\n\n` +
    formatActionPlan(
      [
        `Use TaskCreate to add at least one pending task for the next logical step (e.g. "${suggestion}").`,
        "Then retry this completion — it will succeed once a pending task exists.",
      ],
      { translateToolNames: true }
    ) +
    `\nThe task list must never be fully complete — there is always a next step to plan.`
  )
}

/** True when a task status counts as terminal work. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "deleted"
}

const defaultTaskExecutor: (args: string[]) => Promise<number> = async (args) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc.exitCode ?? 1
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== "null" && !!sessionId.trim()
}

function sanitizePathComponent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "")
}

/** Validate session/sentinel inputs and check dedup sentinel. */
async function validateCreateTaskInputs(
  sessionId: string | undefined,
  sentinelKey: string
): Promise<{ safeSentinel: string; safeSession: string; sentinel: string } | null> {
  if (!isValidSessionId(sessionId) || !sentinelKey.trim()) return null
  const home = getHomeDirOrNull()
  if (!home) return null
  const safeSentinel = sanitizePathComponent(sentinelKey)
  const safeSession = sanitizePathComponent(sessionId)
  if (!safeSentinel || !safeSession) return null
  const sentinel = sessionTaskSentinelPath(safeSentinel, safeSession)
  if (await Bun.file(sentinel).exists()) return null
  return { safeSentinel, safeSession, sentinel }
}

/** Write sentinel file to mark a task as already created. */
async function writeSentinel(sentinel: string): Promise<void> {
  try {
    await Bun.write(sentinel, "")
  } catch {}
}

/** Build the argv array for `swiz tasks create` subprocess calls. */
function buildTaskCreateArgs(
  swizBin: string,
  subject: string,
  description: string,
  sessionId: string
): string[] {
  return [swizBin, "tasks", "create", subject, description, "--session", sessionId]
}

/** Fallback: create task via subprocess when in-process import fails. */
async function createTaskViaSubprocess(
  subject: string,
  description: string,
  sessionId: string,
  sentinel: string
): Promise<void> {
  const home = getHomeDirOrNull()
  if (!home) return
  const swiz = Bun.which("swiz") ?? join(home, ".bun", "bin", "swiz")
  const exitCode = await defaultTaskExecutor(
    buildTaskCreateArgs(swiz, subject, description, sessionId)
  )
  if (exitCode === 0) await writeSentinel(sentinel)
}

/**
 * Create a session task in-process with sentinel dedup.
 *
 * Calls `createTaskInProcess` directly — no subprocess overhead.
 * The `executor` parameter exists only for backward-compatible test injection;
 * when provided, it falls back to the legacy subprocess path.
 */
export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string,
  executor?: (args: string[]) => Promise<number>
): Promise<void> {
  const validated = await validateCreateTaskInputs(sessionId, sentinelKey)
  if (!validated) return
  const { sentinel } = validated

  // Legacy path: test-injected executor shells out to swiz CLI
  if (executor) {
    const exitCode = await executor(
      buildTaskCreateArgs("swiz", subject, description, sessionId ?? "")
    )
    if (exitCode === 0) await writeSentinel(sentinel)
    return
  }

  // In-process path: direct disk write, no subprocess
  try {
    const { createTaskInProcess } = await import("../tasks/task-service.ts")
    await createTaskInProcess({ sessionId: sessionId!, subject, description })
    await writeSentinel(sentinel)
  } catch (err) {
    stderrLog(
      "createSessionTask fallback",
      `[swiz] createSessionTask: in-process creation failed (${messageFromUnknownError(err)}), falling back to subprocess`
    )
    await createTaskViaSubprocess(subject, description, sessionId ?? "", sentinel)
  }
}

// ─── Command normalisation (re-exported from src/) ──────────────────────
export { normalizeCommand, stripHeredocs } from "../command-utils.ts"
// ─── Task creation (re-exported from src/) ───────────────────────────────
export { type CreateTaskOptions, createTaskInProcess } from "../tasks/task-service.ts"
// ─── Transcript summary (re-exported from src/) ────────────────────────
export {
  type CurrentSessionTaskToolStats,
  computeTranscriptSummary,
  deriveCurrentSessionTaskToolStats,
  findLastTaskToolCallIndex,
  getBashCommandsUsedForCurrentSession,
  getCurrentSessionTaskToolStats,
  getSkillsUsedForCurrentSession,
  getToolsUsedForCurrentSession,
  getTranscriptSummary,
  parseTranscriptSummary,
  type TranscriptSummary,
} from "../transcript-summary.ts"

// ─── Branch, git status, and source file utilities ─────────────────────
// Implementations live in ./utils/git-utils.ts; re-exported here for
// backward-compatible access via the single hook-utils.ts import.

export type {
  ChangeScopeResult,
  ClassifyChangeScopeOptions,
  GitStatSummary,
  GitStatusCounts,
  GitStatusV2,
} from "./git-utils.ts"
export {
  BRANCH_CHECK_RE,
  CI_WAIT_RE,
  classifyChangeScope,
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
  extractCheckoutNewBranchName,
  extractMergeBranch,
  extractOwnerFromUrl,
  extractPrNumber,
  FORCE_PUSH_RE,
  GH_CMD_RE,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_MERGE_RE,
  GIT_ANY_CMD_RE,
  GIT_CHECKOUT_RE,
  GIT_COMMIT_RE,
  GIT_EMPTY_TREE,
  GIT_MERGE_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  GIT_READ_RE,
  GIT_SWITCH_RE,
  GIT_SYNC_RE,
  GIT_WRITE_RE,
  getCurrentGitHubUser,
  getDefaultBranch,
  getGitAheadBehind,
  getGitStatusV2,
  getRepoNameWithOwner,
  hasGitPushForceFlag,
  isDefaultBranch,
  isGitHubHost,
  PR_CHECK_RE,
  parseGitStatSummary,
  parseGitStatus,
  parseRemoteUrl,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  type RemoteInfo,
  recentHeadRange,
  SETUP_CMD_RE,
  SOURCE_EXT_RE,
  SWIZ_ISSUE_RE,
  TEST_FILE_RE,
} from "./git-utils.ts"

// ─── Transcript parsing ─────────────────────────────────────────────────
// Implementations live in ./utils/transcript.ts; re-exported here for
// backward-compatible access via the single hook-utils.ts import.

export {
  collectBlockedToolUseIds,
  extractBashCommands,
  extractSkillInvocations,
  extractToolBlocksFromEntry,
  extractToolNamesFromTranscript,
  readAllTranscriptLines,
  readSessionLines,
  stripAnsi,
} from "./transcript.ts"

function isExemptGitCommand(command: string): boolean {
  return GIT_READ_RE.test(command) || GIT_WRITE_RE.test(command)
}

function isExemptUtilityCommand(command: string): boolean {
  return (
    READ_CMD_RE.test(command) ||
    RECOVERY_CMD_RE.test(command) ||
    GH_CMD_RE.test(command) ||
    SWIZ_CMD_RE.test(command) ||
    SETUP_CMD_RE.test(command)
  )
}

/** True when a shell command is exempt from task-tracking enforcement. */
export function isTaskTrackingExemptShellCommand(command: string): boolean {
  return isExemptGitCommand(command) || isExemptUtilityCommand(command)
}

// Re-exported from src/git-helpers.ts
export { type ForkTopology, issueState } from "../git-helpers.ts"
export { isSettingDisableCommand } from "./inline-hook-helpers.ts"

// ─── Fork-aware guidance helpers ───────────────────────────────────────────

/**
 * Build fork-aware git push command guidance.
 * In fork workflows, you push to origin (your fork). The command is the same,
 * but the context message differs.
 */
export function forkPushCmd(
  branch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork) return `git push origin ${branch}  # pushes to your fork (${fork.originSlug})`
  return `git push origin ${branch}`
}

/**
 * Build fork-aware PR creation command.
 * In fork workflows, PRs target the upstream repo.
 */
export function forkPrCreateCmd(
  defaultBranch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork) return `gh pr create --repo ${fork.upstreamSlug} --base ${defaultBranch}`
  return `gh pr create --base ${defaultBranch}`
}

/**
 * Build fork-aware sync guidance (fetch + rebase from upstream).
 * Returns null when not in a fork workflow.
 */
export function forkSyncGuidance(
  defaultBranch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string | null {
  if (!fork) return null
  const lines = [
    `Sync your fork with upstream:`,
    `  git fetch upstream`,
    `  git rebase upstream/${defaultBranch}`,
  ]
  if (!fork.hasUpstreamRemote) {
    lines.unshift(`Set up the upstream remote first:`)
    lines.splice(1, 0, `  git remote add upstream https://github.com/${fork.upstreamSlug}.git`)
  }
  return lines.join("\n")
}

/**
 * Build the remote ref prefix for diff ranges.
 * In fork workflows where upstream is configured, use upstream/<branch>
 * for comparing against the canonical repo's default branch.
 */
export function forkRemoteRef(
  branch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork?.hasUpstreamRemote) return `upstream/${branch}`
  return `origin/${branch}`
}

// ─── Common input types ─────────────────────────────────────────────────

// export interface ToolHookInput {
//   cwd?: string
//   session_id?: string
//   tool_name?: string
//   tool_input?: Record<string, unknown>
//   transcript_path?: string
// }

// export interface SessionHookInput {
//   cwd?: string
//   session_id?: string
//   trigger?: string
//   matcher?: string
//   hook_event_name?: string
// }

export { spawnSpeak } from "../speech.ts"

// ─── File utilities ───────────────────────────────────────────────────────

export { countFileWords } from "../file-metrics.ts"
// ─── Auto-steer scheduling (extracted to auto-steer-helpers.ts) ────────────
export {
  type AutoSteerRequest,
  consumeAutoSteerRequest,
  isAutoSteerAvailable,
  isAutoSteerDeferredForForegroundAppName,
  type SendAutoSteerOptions,
  scheduleAutoSteer,
  sendAutoSteer,
  shouldDeferAutoSteerForForegroundChatApp,
} from "./auto-steer-helpers.ts"
/**
 * Returns true when a file path should be skipped by source-scanning hooks.
 * Always skips non-source files (unrecognised extension). Pass any additional
 * per-hook exclusion regexes as extra arguments.
 */
// ─── Edit delta resolution ──────────────────────────────────────────────────
// Canonical implementations live in edit-projection.ts.
export {
  type EditDelta,
  isExcludedSourcePath,
  resolveEditDelta,
} from "./edit-projection.ts"

/** ToolHookInput extended with typed task tool_input fields. */
export interface TaskToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    status?: string
    subject?: string
    description?: string
    activeForm?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}
