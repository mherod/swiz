// Shared utilities for swiz hook scripts.
// Import with: import { denyPreToolUse, allowPreToolUseWithUpdatedInput, isShellTool, isEditTool, ... } from "./hook-utils.ts";

// ─── Runtime dependency check ───────────────────────────────────────────────
// Verify bun is reachable on PATH. This file executes inside bun, but the
// check catches mangled PATH in non-interactive agent shells where the user's
// profile wasn't sourced. Uses Bun.which() for a fast lookup (no spawn).

if (!Bun.which("bun")) {
  console.error(
    "swiz: bun is not reachable on PATH in this shell environment. " +
      "Hooks that invoke bun scripts will fail. " +
      "Ensure bun is installed: curl -fsSL https://bun.sh/install | bash"
  )
}

// ─── Project convention detection ───────────────────────────────────────────
// Walk up from CWD looking for lockfiles to determine the project's package
// manager and runtime. Cached per process so hooks don't stat the filesystem
// on every import.

import { dirname, join } from "node:path"
import type { Subprocess } from "bun"
import { orderBy } from "lodash-es"
import { translateMatcher } from "../../src/agents.ts"
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "../../src/detect.ts"
import { getHomeDirOrNull, getHomeDirWithFallback } from "../../src/home.ts"
import {
  getStatePath,
  getSwizSettingsPath,
  STATE_TRANSITIONS,
  stateDataSchema,
} from "../../src/settings.ts"
import { skillAdvice, skillExists } from "../../src/skill-utils.ts"
import { backfillTaskTimingFields } from "../../src/tasks/task-timing.ts"
import { sessionTaskSentinelPath } from "../../src/temp-paths.ts"
import {
  GH_CMD_RE,
  GIT_CHECKOUT_RE,
  GIT_COMMIT_RE,
  GIT_READ_RE,
  GIT_SWITCH_RE,
  GIT_SYNC_RE,
  GIT_WRITE_RE,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  SETUP_CMD_RE,
} from "./git-utils.ts"
import { shellTokenCommandRe } from "./shell-patterns.ts"

export { skillAdvice, skillExists }
export { detectCurrentAgent, isCurrentAgent, isRunningInAgent }

// ─── Canonical path hashing — re-exported from src/git-helpers.ts ────────────
export { getCanonicalPathHash } from "../../src/git-helpers.ts"
export { resolveSafeSessionId, sanitizeSessionId, sessionPrefix } from "../../src/session-id.ts"

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

export type { Framework, ProjectStack } from "../../src/detect-frameworks.ts"
export {
  clearFrameworkCache,
  detectFrameworks,
  detectProjectStack,
} from "../../src/detect-frameworks.ts"

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
} from "../../src/tool-matchers.ts"

// Local import for names used within this file (re-exports don't create local bindings)
import {
  isEditTool as _isEditTool,
  isNotebookTool as _isNotebookTool,
} from "../../src/tool-matchers.ts"

// ─── Subprocess timeout enforcement ─────────────────────────────────────────
// Hooks that spawn subprocesses (lint, typecheck, prettier, git, gh, etc.)
// must use this utility to prevent hangs. SIGTERM is sent on timeout,
// escalated to SIGKILL after a grace period.

/** Grace period before escalating SIGTERM → SIGKILL (ms). */
const SUBPROCESS_SIGKILL_GRACE_MS = 3_000

export interface SpawnWithTimeoutResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * Spawn a subprocess with a hard timeout. On expiry, sends SIGTERM then
 * escalates to SIGKILL after the grace period. Returns stdout, stderr,
 * exit code, and whether the timeout fired.
 *
 * @param cmd  Command array, e.g. `["bun", "run", "lint"]`
 * @param opts.cwd  Working directory for the subprocess
 * @param opts.timeoutMs  Hard timeout in milliseconds (default: 30_000)
 * @param opts.stdin  Optional stdin content to pipe into the process
 */
export async function spawnWithTimeout(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {}
): Promise<SpawnWithTimeoutResult> {
  const { cwd, timeoutMs = 30_000, stdin } = opts

  const finish = async (
    proc: Subprocess<"pipe" | "ignore", "pipe", "pipe">
  ): Promise<SpawnWithTimeoutResult> => {
    let timedOut = false
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      sigkillTimer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, SUBPROCESS_SIGKILL_GRACE_MS)
    }, timeoutMs)

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    return {
      stdout,
      stderr,
      exitCode: proc.exitCode,
      timedOut,
    }
  }

  if (stdin !== undefined) {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void proc.stdin.write(stdin)
    void proc.stdin.end()
    return finish(proc)
  }

  return finish(
    Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  )
}

// ─── Projected content computation ──────────────────────────────────────────
// Shared by PreToolUse hooks that validate file content before writes.
// For Edit: reads current file, applies old→new replacement.
// For Write/NotebookEdit: returns content directly.
// Returns null when the projected content cannot be determined.

interface ProjectedContentInput {
  old_string?: string
  new_string?: string
  content?: string
}

/**
 * Compute what a file's content will be after a tool applies its edit.
 * Used by PreToolUse hooks to validate file content before the write happens.
 *
 * Returns null if the projected content cannot be determined (e.g. file unreadable
 * on an Edit where both old/new are empty).
 */
async function computeEditToolContent(
  filePath: string,
  oldString: string,
  newString: string
): Promise<string | null> {
  if (!oldString && !newString) return null
  try {
    const currentContent = await Bun.file(filePath).text()
    return currentContent.replace(oldString, () => newString)
  } catch {
    return null
  }
}

export async function computeProjectedContent(
  toolName: string,
  filePath: string,
  toolInput: ProjectedContentInput
): Promise<string | null> {
  if (_isNotebookTool(toolName)) {
    return (toolInput.content ?? "") || null
  }

  if (_isEditTool(toolName)) {
    const oldString = toolInput.old_string ?? ""
    const newString = toolInput.new_string ?? ""
    return computeEditToolContent(filePath, oldString, newString)
  }

  // Write tool — content is the full file
  return (toolInput.content ?? "") || null
}

/**
 * Returns true if the Bash command is a `swiz` CLI invocation.
 * Swiz commands are globally exempt from PreToolUse blocking because the CLI
 * performs its own validation — blocking the project's own entry point creates
 * unrecoverable deadlocks (e.g. can't run `swiz state set` to escape a state
 * that blocks Bash).
 */
const SWIZ_CMD_RE = shellTokenCommandRe("swiz(?:\\s|$)")
export function isSwizCommand(input: ToolHookInput): boolean {
  const cmd = String(input.tool_input?.command ?? "")
  return SWIZ_CMD_RE.test(cmd)
}

// ─── Placeholder subject detection ──────────────────────────────────────────
// Shared by task-subject-validation (rejects placeholders for new tasks) and
// swiz tasks verifyTaskMatch (exempts placeholders from subject verification).
// All auto-generated placeholder subjects must be captured here so both
// validators stay in sync.

/**
 * Matches all auto-generated placeholder task subjects:
 *   - "Recovered task #N (lost during compaction)" — pretooluse-task-recovery / posttooluse-task-recovery
 *   - "Session bootstrap — describe current work"  — legacy pretooluse-require-tasks placeholder
 */
export const PLACEHOLDER_SUBJECT_RE = /^(?:recovered task|session bootstrap)\b/i

/** Returns true if the subject is an auto-generated placeholder (not real agent work). */
export function isPlaceholderSubject(subject: string): boolean {
  return PLACEHOLDER_SUBJECT_RE.test(subject.trim())
}

// ─── Hook response helpers ─────────────────────────────────────────────────
// Outputs polyglot JSON understood by Claude Code, Cursor, Gemini CLI, and Codex CLI.

/** Emit a PreToolUse denial and exit. Appends ACTION REQUIRED footer. Works across all agents. */
export function denyPreToolUse(reason: string, options: ActionRequiredOptions = {}): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason + preToolActionRequired(reason, options),
      },
    })
  )
  process.exit(0)
}

/** Emit a PreToolUse allow with advisory context and exit. Does NOT block. Works across all agents. */
export function allowPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    })
  )
  process.exit(0)
}

/** Emit a PreToolUse allow with both a visible hint and additionalContext. */
export function allowPreToolUseWithContext(reason: string, additionalContext: string): never {
  const effectiveReason = reason || additionalContext
  console.log(
    JSON.stringify({
      ...(additionalContext && { systemMessage: additionalContext }),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(effectiveReason && { permissionDecisionReason: effectiveReason }),
        ...(additionalContext && { additionalContext }),
      },
    })
  )
  process.exit(0)
}

/** Emit a PreToolUse allow with modified tool input and exit. Works across all agents. */
export function allowPreToolUseWithUpdatedInput(
  updatedInput: Record<string, unknown>,
  reason?: string
): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(reason && { permissionDecisionReason: reason }),
        updatedInput,
      },
    })
  )
  process.exit(0)
}

/**
 * Factory for file-path guard PreToolUse hooks.
 *
 * Returns an async `main()` that parses stdin, tests the file path against
 * `predicate`, and calls `denyPreToolUse` / `allowPreToolUse` accordingly.
 * Absorbs the boilerplate shared by lockfile, node_modules, and similar guards.
 */
export function filePathGuardHook(
  predicate: (filePath: string) => boolean,
  denyReason: string,
  allowMsg?: string | ((filePath: string) => string)
): () => Promise<void> {
  return async () => {
    const { fileEditHookInputSchema } = await import("../schemas.ts")
    const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
    const filePath = input.tool_input?.file_path ?? ""
    if (predicate(filePath)) denyPreToolUse(denyReason)
    const msg = typeof allowMsg === "function" ? allowMsg(filePath) : (allowMsg ?? "")
    allowPreToolUse(msg)
  }
}

/** Emit a PostToolUse block decision and exit. Works across all agents. */
export function denyPostToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reason,
      },
    })
  )
  process.exit(0)
}

/** Read current project state line, e.g. "State: developing → [reviewing, planning]". */
async function readStateMaybe(cwd: string): Promise<string | null> {
  try {
    const raw = await Bun.file(getStatePath(cwd)).text()
    const result = stateDataSchema.safeParse(JSON.parse(raw))
    if (!result.success) return null
    const allowed = STATE_TRANSITIONS[result.data.state]
    return `State: ${result.data.state} → [${allowed.join(", ")}]`
  } catch {
    return null
  }
}

/** Emit additional context for a hook event. Works across all agents.
 *  For PostToolUse events, appends current project state + allowed transitions when a state is set. */
export async function emitContext(
  eventName: string,
  context: string,
  cwd?: string
): Promise<never> {
  const stateLine = eventName === "PostToolUse" ? await readStateMaybe(cwd ?? process.cwd()) : null
  const fullContext = stateLine ? `${context} ${stateLine}` : context
  console.log(
    JSON.stringify({
      systemMessage: fullContext,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: fullContext,
      },
    })
  )
  process.exit(0)
}

// ─── Stop hook helpers ────────────────────────────────────────────────────

export { type ActionPlanItem, formatActionPlan } from "../../src/action-plan.ts"

/** Return the current agent's tool name for a canonical tool identifier. */
export function toolNameForCurrentAgent(canonicalName: string): string {
  const agent = detectCurrentAgent()
  if (!agent) return canonicalName
  return translateMatcher(canonicalName, agent) ?? canonicalName
}

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

const _updateMemoryFooterEnabledCache: boolean = await (async () => {
  const settingsPath = getSwizSettingsPath()
  if (!settingsPath) return false
  try {
    if (!(await Bun.file(settingsPath).exists())) return false
    const parsed = (await Bun.file(settingsPath).json()) as Record<string, unknown>
    return parsed.updateMemoryFooter === true
  } catch {
    return false
  }
})()

function isUpdateMemoryFooterEnabled(): boolean {
  return _updateMemoryFooterEnabledCache
}

type ActionRequiredOptions = {
  includeUpdateMemoryAdvice?: boolean
}

function memoryAdvice(include: boolean, reason: string): string {
  if (!include || !isUpdateMemoryFooterEnabled()) return ""
  return `\n\n${updateMemoryAdvice(reason)}`
}

/** Standard ACTION REQUIRED footer for PreToolUse denials. */
export function preToolActionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: Fix the underlying issue before retrying. This hook will deny this tool call every time this violation is present. Do not attempt to bypass or work around it — address the root cause.${memory}`
}

/** Standard ACTION REQUIRED footer appended to all stop hook block reasons. */
export function actionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action.${memory}`
}

/** Emit a stop block decision and exit. Appends ACTION_REQUIRED footer. */
export function blockStop(
  reason: string,
  options: { includeUpdateMemoryAdvice?: boolean } = {}
): never {
  console.log(
    JSON.stringify({ decision: "block", reason: reason + actionRequired(reason, options) })
  )
  process.exit(0)
}

/** Emit a raw stop block (no footer appended — caller controls the full reason). */
export function blockStopRaw(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason }))
  process.exit(0)
}

/**
 * Emit a stop block that requires human action to resolve.
 * Adds `resolution: "human-required"` to the output so the agent understands
 * it cannot resolve the block autonomously — a human must intervene.
 * Appends a note to the reason explaining this.
 */
export function blockStopHumanRequired(reason: string): never {
  const fullReason = `${reason}\n\nACTION REQUIRED: Resolve this block before stopping.`
  console.log(
    JSON.stringify({ decision: "block", reason: fullReason, resolution: "human-required" })
  )
  process.exit(0)
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

/**
 * File a GitHub issue for a follow-up finding and allow stop.
 * Returns the created issue number on success, or null if filing failed.
 * On failure, falls back to blocking stop so the finding is not lost.
 */
export async function fileFollowUpIssue(
  options: FollowUpIssueOptions,
  blockReason: string
): Promise<number | null> {
  const { title, body, labels = ["backlog", "enhancement"], cwd, sessionId } = options

  if (!hasGhCli()) {
    // Can't file — fall back to blocking
    blockStop(`${blockReason}\n\n(Could not auto-file follow-up issue: gh CLI unavailable)`, {
      includeUpdateMemoryAdvice: false,
    })
  }

  // Build the issue body with session context
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

    // Extract issue number from gh output (URL like https://github.com/owner/repo/issues/123)
    const match = output.match(/\/issues\/(\d+)/)
    const issueNum = match?.[1] ? Number.parseInt(match[1], 10) : null

    // Clean up temp file
    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }

    return issueNum
  } catch {
    // Filing failed — fall back to blocking so finding isn't lost
    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }
    blockStop(`${blockReason}\n\n(Failed to auto-file follow-up issue)`, {
      includeUpdateMemoryAdvice: false,
    })
  }
}

// ─── Git / CLI helpers ──────────────────────────────────────────────────
// Canonical definitions live in src/git-helpers.ts. Imported here so
// internal callers within hook-utils can reference them, and re-exported
// so all hook scripts can keep importing from "./hook-utils.ts" unchanged.

import {
  getOpenPrForBranch,
  getRepoSlug,
  gh,
  ghJsonViaDaemon,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "../../src/git-helpers.ts"

/**
 * Hooks should prefer daemon-backed gh query caching to reduce API pressure.
 * Falls back to direct gh + local TTL cache when daemon is unavailable.
 */
async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
  return ghJsonViaDaemon<T>(args, cwd, { ttlMs: 300_000 })
}

export { getOpenPrForBranch, getRepoSlug, gh, ghJson, git, hasGhCli, isGitHubRemote, isGitRepo }

// ─── Issue guidance consolidation ──────────────────────────────────────────
// Shared formatter for "file an issue on the target repo instead" messaging.

/**
 * Build standardized guidance text for filing an issue on a target repository.
 * Consolidates the "file an issue instead of editing externally" messaging pattern.
 *
 * @param repo - Repository slug (owner/repo) or null for generic placeholder
 * @param options - Configuration for the guidance message
 * @returns Formatted guidance text ready for user display
 */
export function buildIssueGuidance(
  repo: string | null,
  options?: { crossRepo?: boolean; hostname?: string }
): string {
  const isCrossRepo = options?.crossRepo ?? false
  const hostname = options?.hostname ?? "github.com"
  const hostnameFlag = hostname !== "github.com" ? ` --hostname ${hostname}` : ""
  const repoSlug = repo ?? "<owner>/<repo>"

  const prefix = isCrossRepo
    ? "If this change is needed, consider filing an issue there so the repo can triage it:"
    : "If you need to edit a file outside the project, file an issue on the target repo instead:"

  return `${prefix}\n  gh issue create --repo ${repoSlug}${hostnameFlag} --title "..." --body "..."`
}

// ─── Session task I/O ────────────────────────────────────────────────────────

/**
 * Canonical shape for a task file stored in ~/.claude/tasks/<session-id>/<id>.json.
 * All fields except id/subject/status are optional so callers that only need
 * the minimal shape don't have to cast.
 */
export interface SessionTask {
  id: string
  subject: string
  status: string
  description?: string
  activeForm?: string
  blocks?: string[]
  blockedBy?: string[]
  completionEvidence?: string
  completionTimestamp?: string
  statusChangedAt?: string
  elapsedMs?: number
  startedAt?: number | null
  completedAt?: number | null
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

/** Resolve ~/.claude/tasks for the active home directory. */
export function getTasksRoot(home: string = getHomeDirWithFallback("")): string | null {
  if (!home) return null
  return join(home, ".claude", "tasks")
}

/** Resolve ~/.claude/projects for the active home directory. */
export function getProjectsRoot(home: string = getHomeDirWithFallback("")): string | null {
  if (!home) return null
  return join(home, ".claude", "projects")
}

/** Resolve ~/.claude/tasks/<sessionId> for the active home directory. */
export function getSessionTasksDir(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksRoot = getTasksRoot(home)
  if (!tasksRoot || !sessionId) return null
  return join(tasksRoot, sessionId)
}

/** Resolve ~/.claude/tasks/<sessionId>/<taskId>.json for task file access. */
export function getSessionTaskPath(
  sessionId: string,
  taskId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir || !taskId) return null
  return join(tasksDir, `${taskId}.json`)
}

/** Resolve ~/.claude/tasks/<sessionId>/compact-snapshot.json. */
export function getSessionCompactSnapshotPath(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): string | null {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null
  return join(tasksDir, "compact-snapshot.json")
}

/** True when a session task directory exists and can be listed. */
export async function hasSessionTasksDir(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<boolean> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return false
  try {
    const { readdir } = await import("node:fs/promises")
    await readdir(tasksDir)
    return true
  } catch {
    return false
  }
}

// ─── Subject fingerprinting (re-exported from src/) ─────────────────────
export {
  computeSubjectFingerprint,
  normalizeSubject,
  significantWords,
  stemWord,
  subjectsOverlap,
} from "../../src/subject-fingerprint.ts"

import { computeSubjectFingerprint } from "../../src/subject-fingerprint.ts"

/**
 * Read all task files for a session from ~/.claude/tasks/<sessionId>/.
 * Returns an empty array when the directory doesn't exist or can't be read.
 * Skips files that fail to parse or don't end with .json.
 */
async function readTaskFile(tasksDir: string, fileName: string): Promise<SessionTask | null> {
  if (!fileName.endsWith(".json") || fileName.startsWith(".")) return null
  try {
    const task = (await Bun.file(join(tasksDir, fileName)).json()) as SessionTask
    if (task.id && task.subject && task.status) {
      // Backfill fingerprint for tasks that predate the field
      if (!task.subjectFingerprint) {
        task.subjectFingerprint = computeSubjectFingerprint(task.subject)
      }
      backfillTaskTimingFields(task)
      return task
    }
  } catch {
    // skip unreadable or malformed task files
  }
  return null
}

export async function readSessionTasks(
  sessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<SessionTask[]> {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return []
  let files: string[]
  try {
    const { readdir } = await import("node:fs/promises")
    files = await readdir(tasksDir)
  } catch {
    return []
  }
  const tasks: SessionTask[] = []
  for (const f of files) {
    const task = await readTaskFile(tasksDir, f)
    if (task) tasks.push(task)
  }
  // Sort tasks by ID to ensure deterministic output
  return orderBy(tasks, [(t) => t.id], ["asc"])
}

/**
 * Result of scanning prior sessions for incomplete tasks.
 * Includes the session ID so callers can construct `swiz tasks complete --session` commands.
 */
export interface PriorSessionResult {
  sessionId: string
  tasks: SessionTask[]
}

export interface LimitedItems<T> {
  visible: T[]
  remaining: number
}

/** Limit repeated context items so hook output stays bounded. */
export function limitItems<T>(items: T[], limit = 3): LimitedItems<T> {
  if (limit <= 0) return { visible: [], remaining: items.length }
  const visible = items.slice(0, limit)
  return {
    visible,
    remaining: Math.max(items.length - visible.length, 0),
  }
}

/**
 * Find incomplete tasks from the most recent prior session for a given project.
 *
 * Scans ~/.claude/projects/<projectKey>/ for session transcript IDs, then checks
 * ~/.claude/tasks/<sessionId>/ for incomplete tasks (pending | in_progress).
 * Returns tasks from the most recently-modified session that has any tasks,
 * excluding `excludeSessionId` (the current session).
 */
async function collectSessionsFromTranscripts(
  projectDir: string,
  excludeSessionId: string
): Promise<{ id: string; mtime: number }[]> {
  const { readdir, stat } = await import("node:fs/promises")
  let transcriptFiles: string[]
  try {
    transcriptFiles = await readdir(projectDir)
  } catch {
    return []
  }

  const sessions: { id: string; mtime: number }[] = []
  for (const f of transcriptFiles) {
    if (!f.endsWith(".jsonl")) continue
    const id = f.slice(0, -6)
    if (id === excludeSessionId) continue
    try {
      const s = await stat(join(projectDir, f))
      sessions.push({ id, mtime: s.mtimeMs })
    } catch {}
  }
  return orderBy(sessions, [(session) => session.mtime], ["desc"])
}

export async function findPriorSessionTasks(
  cwd: string,
  excludeSessionId: string,
  home: string = getHomeDirWithFallback("")
): Promise<PriorSessionResult | null> {
  if (!home || !cwd) return null
  const { projectKeyFromCwd } = await import("../../src/transcript-utils.ts")

  const projectKey = projectKeyFromCwd(cwd)
  const projectsRoot = getProjectsRoot(home)
  if (!projectsRoot) return null
  const projectDir = join(projectsRoot, projectKey)

  const orderedSessions = await collectSessionsFromTranscripts(projectDir, excludeSessionId)

  // Walk sessions newest-first; return incomplete tasks from first session with tasks
  for (const { id } of orderedSessions) {
    const tasks = await readSessionTasks(id, home)
    const incomplete = tasks
      .filter((t) => isIncompleteTaskStatus(t.status))
      // Filter to only numeric IDs (user-created tasks), excluding legacy prefixed placeholders
      .filter((t) => /^\d+$/.test(t.id))
    if (incomplete.length > 0) return { sessionId: id, tasks: incomplete }
  }
  return null
}

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

/** True when a task status counts as incomplete work. */
export function isIncompleteTaskStatus(status: string): boolean {
  return status === "pending" || status === "in_progress"
}

/** True when a task status counts as terminal work. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "deleted"
}

/**
 * Format task subjects for denial messages.
 * Uses active task lines when present; otherwise falls back to all tasks.
 */
export function formatTaskSubjectsForDisplay(
  allTasks: SessionTask[],
  activeTaskSubjects: string[]
): string {
  const displayTasks =
    activeTaskSubjects.length > 0
      ? activeTaskSubjects
      : allTasks.map((t) => `#${t.id} (${t.status}): ${t.subject}`)
  return displayTasks.map((t) => `  ${t}`).join("\n")
}

export interface FormatTaskListOptions {
  limit?: number
  overflowLabel?: string
  indent?: string
  subjectMaxLength?: number
}

function truncateTaskSubject(subject: string, maxLength: number | undefined): string {
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) return subject
  const safeMax = Math.max(0, Math.floor(maxLength))
  if (safeMax === 0) return ""
  if (subject.length <= safeMax) return subject
  if (safeMax <= 3) return subject.slice(0, safeMax)
  return `${subject.slice(0, safeMax - 3)}...`
}

/**
 * Render tasks as a bullet list, optionally capped with an overflow line.
 * Useful for hook messages that need bounded context.
 */
export function formatTaskList(
  tasks: Array<Pick<SessionTask, "id" | "status" | "subject">>,
  options: FormatTaskListOptions = {}
): string {
  if (tasks.length === 0) return ""
  const indent = options.indent ?? "  "
  const limit = options.limit ?? tasks.length
  const subjectMaxLength = options.subjectMaxLength
  const { visible, remaining } = limitItems(tasks, limit)
  const lines = visible
    .map(
      (t) =>
        `${indent}• #${t.id} [${t.status}]: ${truncateTaskSubject(t.subject, subjectMaxLength)}`
    )
    .join("\n")
  if (remaining === 0) return lines
  const overflowLabel = options.overflowLabel ?? "task(s)"
  return `${lines}\n${indent}... ${remaining} more ${overflowLabel}`
}

/**
 * Render a single `swiz tasks complete` command.
 * Pass `<id>` when showing a template rather than a concrete task command.
 */
export function formatTaskCompleteCommand(
  taskId: string,
  sessionId: string,
  evidence: string,
  options: { indent?: string } = {}
): string {
  const indent = options.indent ?? ""
  return `${indent}swiz tasks complete ${taskId} --session ${sessionId} --evidence "${evidence}"`
}

/** Render one `swiz tasks complete` command per task. */
export function formatTaskCompleteCommands(
  tasks: Array<Pick<SessionTask, "id">>,
  sessionId: string,
  evidence: string,
  options: { indent?: string } = {}
): string {
  return tasks
    .map((t) => formatTaskCompleteCommand(String(t.id), sessionId, evidence, options))
    .join("\n")
}

/**
 * Executor type for createSessionTask — injectable for testing.
 * Receives the full argv array and returns the process exit code.
 */
export type TaskExecutor = (args: string[]) => Promise<number>

const defaultTaskExecutor: TaskExecutor = async (args) => {
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

async function executeWithFallback(executor: TaskExecutor, args: string[]): Promise<number> {
  try {
    return await executor(args)
  } catch (err) {
    console.error(
      `[swiz] createSessionTask: executor threw (${err instanceof Error ? err.message : String(err)}), falling back to default`
    )
  }
  try {
    return await defaultTaskExecutor(args)
  } catch (defaultErr) {
    console.error(
      `[swiz] createSessionTask: default executor also threw (${defaultErr instanceof Error ? defaultErr.message : String(defaultErr)}), giving up`
    )
    return 1
  }
}

/** Create a session task via `swiz tasks create`. Uses a sentinel file to fire only once per session. */
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

export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string,
  executor: TaskExecutor = defaultTaskExecutor
): Promise<void> {
  const validated = await validateCreateTaskInputs(sessionId, sentinelKey)
  if (!validated) return
  const { sentinel } = validated

  let exec = executor
  if (typeof exec !== "function") {
    console.error(
      `[swiz] createSessionTask: invalid executor (got ${typeof exec}), falling back to default`
    )
    exec = defaultTaskExecutor
  }

  const home = getHomeDirOrNull()
  if (!home) return
  const swiz = Bun.which("swiz") ?? join(home, ".bun", "bin", "swiz")
  const args = [swiz, "tasks", "create", subject, description, "--session", sessionId ?? ""]
  const exitCode = await executeWithFallback(exec, args)
  if (exitCode === 0) {
    try {
      await Bun.write(sentinel, "")
    } catch {}
  }
}

// ─── Command normalisation (re-exported from src/) ──────────────────────
export { normalizeCommand, stripHeredocs } from "../../src/command-utils.ts"
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
} from "../../src/transcript-summary.ts"

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
  extractToolNamesFromTranscript,
  readAllTranscriptLines,
  readSessionLines,
  stripAnsi,
} from "./transcript.ts"

function isExemptGitCommand(command: string): boolean {
  return (
    (GIT_READ_RE.test(command) && !GIT_WRITE_RE.test(command)) ||
    GIT_SYNC_RE.test(command) ||
    GIT_COMMIT_RE.test(command) ||
    GIT_CHECKOUT_RE.test(command) ||
    GIT_SWITCH_RE.test(command)
  )
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

/** Returns true when a command attempts to disable a swiz setting identified by any of the given aliases. */
export function isSettingDisableCommand(command: string, aliases: string[]): boolean {
  for (const alias of aliases) {
    if (new RegExp(`swiz\\s+settings\\s+disable\\s+${alias}(?:\\s|$)`).test(command)) return true
    if (new RegExp(`swiz\\s+settings\\s+set\\s+${alias}\\s+false(?:\\s|$)`).test(command))
      return true
  }
  return false
}

// Re-exported from src/git-helpers.ts
export { issueState } from "../../src/git-helpers.ts"

// ─── Common input types ─────────────────────────────────────────────────

export interface StopHookInput {
  cwd?: string
  session_id?: string
  stop_hook_active?: boolean
  transcript_path?: string
}

export interface ToolHookInput {
  cwd?: string
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  transcript_path?: string
}

export interface SessionHookInput {
  cwd?: string
  session_id?: string
  trigger?: string
  matcher?: string
  hook_event_name?: string
}

export { spawnSpeak } from "../../src/speech.ts"

// ─── File utilities ───────────────────────────────────────────────────────

export { countFileWords } from "../../src/file-metrics.ts"

import { SOURCE_EXT_RE as _SOURCE_EXT_RE } from "./git-utils.ts"

/**
 * Returns true when a file path should be skipped by source-scanning hooks.
 * Always skips non-source files (unrecognised extension). Pass any additional
 * per-hook exclusion regexes as extra arguments.
 */
export function isExcludedSourcePath(filePath: string, ...extras: RegExp[]): boolean {
  if (!_SOURCE_EXT_RE.test(filePath)) return true
  return extras.some((re) => re.test(filePath))
}

// ─── Edit delta resolution ──────────────────────────────────────────────────

export interface EditDelta {
  oldString: string
  newString: string
}

/**
 * Extract old/new strings from a file-edit hook input, returning null if the
 * file path matches any exclusion pattern. Common extraction shared across
 * hooks that inspect edit content (debug statements, TODO tracker, etc.).
 */
export function resolveEditDelta(
  input: {
    tool_input?: { file_path?: string; old_string?: string; new_string?: string; content?: string }
  },
  ...excludePatterns: RegExp[]
): EditDelta | null {
  const filePath = input.tool_input?.file_path ?? ""
  if (isExcludedSourcePath(filePath, ...excludePatterns)) return null
  return {
    oldString: input.tool_input?.old_string ?? "",
    newString: input.tool_input?.new_string ?? input.tool_input?.content ?? "",
  }
}

// ─── Auto-steer scheduling ─────────────────────────────────────────────────

export interface AutoSteerRequest {
  message: string
  timestamp: number
  trigger?: import("../../src/auto-steer-store.ts").AutoSteerTrigger
}

const AUTOSTEER_SUPPORTED_TERMINALS = new Set(["iterm2", "apple-terminal"])

/**
 * True when the given System Events frontmost process name is a chat app we should
 * not interrupt by activating the terminal (WhatsApp, Telegram, variants).
 */
export function isAutoSteerDeferredForForegroundAppName(name: string): boolean {
  const t = name.trim().toLowerCase()
  return t.startsWith("whatsapp") || t.startsWith("telegram")
}

/**
 * True when the user is currently focused on a chat app; scheduled auto-steer should
 * not consume the request (retry on a later PostToolUse).
 */
export async function shouldDeferAutoSteerForForegroundChatApp(): Promise<boolean> {
  const { createScript, runScript } = await import("applescript-node")
  const script = createScript()
    .tell("System Events")
    .raw("return name of first application process whose frontmost is true")
    .end()
  try {
    const result = await runScript(script)
    const out = typeof result.output === "string" ? result.output.trim() : ""
    return isAutoSteerDeferredForForegroundAppName(out)
  } catch {
    return false
  }
}

type AutoSteerTerminalKind = "iterm2" | "apple-terminal"

async function runAutoSteerTerminalScripts(
  kind: AutoSteerTerminalKind,
  escaped: string,
  createScript: typeof import("applescript-node").createScript,
  runScript: typeof import("applescript-node").runScript
): Promise<void> {
  if (kind === "iterm2") {
    const script = createScript()
      .tell("iTerm")
      .tellTarget("current session of current window")
      .raw(`write text "${escaped}" newline no`)
      .raw(`write text ""`)
      .raw(`delay 0.1`)
      .raw(`write text ""`)
      .end()
      .end()
    await runScript(script)
    return
  }
  const typeScript = createScript()
    .tell("System Events")
    .tellTarget('process "Terminal"')
    .raw(`keystroke "${escaped}"`)
    .raw(`keystroke return`)
    .raw(`delay 0.1`)
    .raw(`keystroke return`)
    .end()
    .end()
  await runScript(typeScript)
}

/**
 * Check whether auto-steer is available (setting enabled + supported terminal).
 * Returns the detected terminal app if available, null otherwise.
 */
export async function isAutoSteerAvailable(sessionId: string): Promise<string | null> {
  const { detectTerminal } = await import("./terminal-detection.ts")
  const terminal = detectTerminal()
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) return null
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../../src/settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  if (!settings.autoSteer) return null
  return terminal.app
}

export type SendAutoSteerOptions = {
  /** If the user focuses a chat app before send, re-schedule this session's request (PostToolUse path). */
  requeueOnForegroundDeferSessionId?: string
}

let autoSteerMutex: Promise<void> = Promise.resolve()

async function withAutoSteerMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = autoSteerMutex
  let release!: () => void
  autoSteerMutex = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

async function deferAutoSteerWhenChatForeground(
  originalFrontApp: string,
  message: string,
  opts?: SendAutoSteerOptions
): Promise<boolean> {
  if (!isAutoSteerDeferredForForegroundAppName(originalFrontApp)) return false
  const sid = opts?.requeueOnForegroundDeferSessionId
  if (sid) await scheduleAutoSteer(sid, message)
  return true
}

/**
 * Send a steering message directly to the terminal via AppleScript.
 * Use this for immediate sends (e.g. stop hooks) where there's no future
 * PostToolUse cycle to consume a scheduled request.
 *
 * Returns true if the message was sent, false if terminal unsupported or send failed.
 */
export async function sendAutoSteer(
  message: string,
  terminalApp?: string | null,
  opts?: SendAutoSteerOptions
): Promise<boolean> {
  return withAutoSteerMutex(async () => {
    const app = terminalApp ?? (await import("./terminal-detection.ts")).detectTerminal().app
    if (!AUTOSTEER_SUPPORTED_TERMINALS.has(app)) return false

    const { createScript, runScript } = await import("applescript-node")
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

    // Utility to bring app to front and to frontmost app again
    async function getFrontmostAppName(): Promise<string> {
      const script = createScript()
        .tell("System Events")
        .raw("return name of first application process whose frontmost is true")
        .end()
      const result = await runScript(script)
      const out = result.output
      return typeof out === "string" ? out.trim() : ""
    }

    // Bring target app to front, send message, and optionally restore original frontmost app
    try {
      let targetApp: string
      if (app === "iterm2") {
        targetApp = "iTerm"
      } else if (app === "apple-terminal") {
        targetApp = "Terminal"
      } else {
        return false
      }

      const originalFrontApp = await getFrontmostAppName()
      if (await deferAutoSteerWhenChatForeground(originalFrontApp, message, opts)) return false

      const alreadyFrontmost = originalFrontApp === targetApp

      // Always bring terminal to front before messaging
      await runScript(createScript().tell(targetApp).raw("activate").end())

      await runAutoSteerTerminalScripts(
        app as AutoSteerTerminalKind,
        escaped,
        createScript,
        runScript
      )

      // If we brought terminal to front and it wasn't already, restore previous front app
      if (!alreadyFrontmost && originalFrontApp) {
        // Only switch back if we switched at the start
        await runScript(createScript().tell(originalFrontApp).raw("activate").end())
      }

      return true
    } catch {
      return false
    }
  })
}

/**
 * Schedule an auto-steer input with a steering prompt message.
 * The message will be typed into the terminal on the next PostToolUse cycle,
 * giving the agent actionable context (not just "Continue").
 *
 * Returns true if the request was scheduled, false if auto-steer is disabled
 * or the terminal doesn't support AppleScript. Callers should fall back to
 * their normal deny/block behavior when this returns false.
 */
export async function scheduleAutoSteer(
  sessionId: string,
  message = "Continue",
  trigger?: import("../../src/auto-steer-store.ts").AutoSteerTrigger,
  cwd?: string
): Promise<boolean> {
  // Check terminal support first (cheap, no I/O)
  const { detectTerminal } = await import("./terminal-detection.ts")
  const terminal = detectTerminal()
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) return false

  // Check autoSteer setting
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../../src/settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  if (!settings.autoSteer) return false

  const { sanitizeSessionId: sanitize } = await import("../../src/session-id.ts")
  const safeSession = sanitize(sessionId)
  if (!safeSession) return false

  const { getAutoSteerStore } = await import("../../src/auto-steer-store.ts")
  const store = getAutoSteerStore()
  store.enqueue(safeSession, message, trigger ?? "next_turn", { cwd })
  return true
}

/**
 * Check whether an auto-steer request is pending for this session.
 * Atomically consumes the request — returns the steering message if pending, null otherwise.
 */
export async function consumeAutoSteerRequest(
  sessionId: string,
  trigger?: import("../../src/auto-steer-store.ts").AutoSteerTrigger
): Promise<AutoSteerRequest | null> {
  const { sanitizeSessionId: sanitize } = await import("../../src/session-id.ts")
  const safeSession = sanitize(sessionId)
  if (!safeSession) return null

  const { getAutoSteerStore } = await import("../../src/auto-steer-store.ts")
  const store = getAutoSteerStore()
  const requests = store.consume(safeSession, trigger ?? "next_turn")
  if (requests.length === 0) return null

  // Return the first request for backward compat; all are marked delivered
  const first = requests[0]!
  return { message: first.message, timestamp: first.createdAt }
}
