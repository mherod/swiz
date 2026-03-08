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

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { translateMatcher } from "../src/agents.ts"
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "../src/detect.ts"
import { readProjectSettings, STATE_TRANSITIONS, stateDataSchema } from "../src/settings.ts"
import { skillAdvice, skillExists } from "../src/skill-utils.ts"

export { skillAdvice, skillExists }
export { detectCurrentAgent, isCurrentAgent, isRunningInAgent }

// ─── Canonical path hashing — re-exported from src/git-helpers.ts ────────────
export { getCanonicalPathHash } from "../src/git-helpers.ts"

/**
 * Derive a short prefix from a session UUID for namespaced task IDs.
 * First 4 hex characters of the session ID (e.g., "a3f2").
 */
export function sessionPrefix(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 4).toLowerCase()
}

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

// ─── Framework detection ──────────────────────────────────────────────────
// Re-exported from src/detect-frameworks.ts so hook scripts can access it
// via the single hook-utils.ts import, and so src/manifest.ts can import
// directly from src/ without creating a src→hooks dependency.

export type { Framework, ProjectStack } from "../src/detect-frameworks.ts"
export {
  _clearFrameworkCache,
  detectFrameworks,
  detectProjectStack,
} from "../src/detect-frameworks.ts"

let _pmCache: PackageManager | null | undefined

export function detectPackageManager(): PackageManager | null {
  if (_pmCache !== undefined) return _pmCache

  let dir = process.cwd()
  while (true) {
    // Primary: Check for packageManager field in package.json (Node.js standard)
    const pkgJsonPath = join(dir, "package.json")
    if (existsSync(pkgJsonPath)) {
      try {
        const content = readFileSync(pkgJsonPath, "utf-8")
        const pkg = JSON.parse(content)
        if (pkg.packageManager && typeof pkg.packageManager === "string") {
          // Format: "pnpm@10.29.3" → extract "pnpm"
          const pmName = pkg.packageManager.split("@")[0] as PackageManager
          if (pmName === "bun" || pmName === "pnpm" || pmName === "yarn" || pmName === "npm") {
            _pmCache = pmName
            return _pmCache
          }
        }
      } catch {
        // If package.json is invalid JSON, continue to other detection methods
      }
    }

    // Secondary: Check for pnpm-specific config hints in .npmrc
    const npmrcPath = join(dir, ".npmrc")
    if (existsSync(npmrcPath)) {
      try {
        const content = readFileSync(npmrcPath, "utf-8")
        // Look for pnpm-specific config keys
        if (
          /^\s*node-linker\s*=\s*hoisted/m.test(content) ||
          /^\s*shamefully-hoist\s*=\s*true/m.test(content) ||
          /^\s*strict-peer-dependencies\s*=\s*false/m.test(content)
        ) {
          _pmCache = "pnpm"
          return _pmCache
        }
      } catch {
        // If .npmrc is unreadable, continue to lock file detection
      }
    }

    // Tertiary: Check for lockfile signals
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
      _pmCache = "bun"
      return _pmCache
    }
    if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "shrinkwrap.yaml"))) {
      _pmCache = "pnpm"
      return _pmCache
    }
    if (
      existsSync(join(dir, "yarn.lock")) ||
      existsSync(join(dir, ".pnp.cjs")) ||
      existsSync(join(dir, ".pnp.js"))
    ) {
      _pmCache = "yarn"
      return _pmCache
    }
    if (
      existsSync(join(dir, "package-lock.json")) ||
      existsSync(join(dir, "npm-shrinkwrap.json"))
    ) {
      _pmCache = "npm"
      return _pmCache
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  _pmCache = null
  return null
}

export function detectRuntime(): Runtime {
  const pm = detectPackageManager()
  return pm === "bun" ? "bun" : "node"
}

/** The "run package" command for the detected PM (e.g. bunx, pnpm dlx, npx) */
export function detectPkgRunner(): string {
  const pm = detectPackageManager()
  switch (pm) {
    case "bun":
      return "bunx"
    case "pnpm":
      return "pnpm dlx"
    case "yarn":
      return "yarn dlx"
    default:
      return "npx"
  }
}

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
} from "../src/tool-matchers.ts"

// Local import for names used within this file (re-exports don't create local bindings)
import { isShellTool, TASK_TOOLS } from "../src/tool-matchers.ts"

/**
 * Returns true if the Bash command is a `swiz` CLI invocation.
 * Swiz commands are globally exempt from PreToolUse blocking because the CLI
 * performs its own validation — blocking the project's own entry point creates
 * unrecoverable deadlocks (e.g. can't run `swiz state set` to escape a state
 * that blocks Bash).
 */
const SWIZ_CMD_RE = /(?:^|\s|&&|\|\||;)swiz(?:\s|$)/
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

/** Read current project state line synchronously, e.g. "State: developing → [reviewing, planning]". */
function readStateLineSyncMaybe(cwd: string): string | null {
  try {
    const raw = readFileSync(join(cwd, ".swiz", "state.json"), "utf-8")
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
export function emitContext(eventName: string, context: string, cwd?: string): never {
  const stateLine =
    eventName === "PostToolUse" ? readStateLineSyncMaybe(cwd ?? process.cwd()) : null
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

/**
 * Format a numbered action plan for inclusion in stop hook block reasons.
 * Returns a "<header>\n  1. ...\n  2. ..." block ready to append to a reason string.
 * When requested, canonical tool names (for example "TaskCreate") are
 * translated to the current agent's tool alias before rendering.
 */
export function formatActionPlan(
  steps: string[],
  options?: { translateToolNames?: boolean; header?: string }
): string {
  if (steps.length === 0) return ""
  const agent = options?.translateToolNames ? detectCurrentAgent() : null
  const renderedSteps = agent ? steps.map((step) => translateMatcher(step, agent) ?? step) : steps
  const numbered = renderedSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
  const header = options?.header ?? "Action plan:"
  return `${header}\n${numbered}\n`
}

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

let _updateMemoryFooterEnabledCache: boolean | undefined

function isUpdateMemoryFooterEnabled(): boolean {
  if (_updateMemoryFooterEnabledCache !== undefined) return _updateMemoryFooterEnabledCache

  const home = process.env.HOME
  if (!home) {
    _updateMemoryFooterEnabledCache = false
    return _updateMemoryFooterEnabledCache
  }

  const settingsPath = join(home, ".swiz", "settings.json")
  if (!existsSync(settingsPath)) {
    _updateMemoryFooterEnabledCache = false
    return _updateMemoryFooterEnabledCache
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
    _updateMemoryFooterEnabledCache = parsed.updateMemoryFooter === true
  } catch {
    _updateMemoryFooterEnabledCache = false
  }

  return _updateMemoryFooterEnabledCache
}

type ActionRequiredOptions = {
  includeReassessmentAdvice?: boolean
  includeUpdateMemoryAdvice?: boolean
}

function reassessmentAdvice(include: boolean): string {
  if (!include) return ""
  return skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
}

function memoryAdvice(include: boolean, reason: string): string {
  if (!include || !isUpdateMemoryFooterEnabled()) return ""
  return `\n\n${updateMemoryAdvice(reason)}`
}

/** Standard ACTION REQUIRED footer for PreToolUse denials. */
export function preToolActionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const reassess = reassessmentAdvice(options.includeReassessmentAdvice ?? true)
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: Fix the underlying issue before retrying. This hook will deny this tool call every time this violation is present. Do not attempt to bypass or work around it — address the root cause.${reassess ? `\n\n${reassess}` : ""}${memory}`
}

/** Standard ACTION REQUIRED footer appended to all stop hook block reasons. */
export function actionRequired(reason = "", options: ActionRequiredOptions = {}): string {
  const reassess = reassessmentAdvice(options.includeReassessmentAdvice ?? true)
  const memory = memoryAdvice(options.includeUpdateMemoryAdvice ?? true, reason)
  return `\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action.${reassess ? `\n\n${reassess}` : ""}${memory}`
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

// ─── Git / CLI helpers ──────────────────────────────────────────────────
// Canonical definitions live in src/git-helpers.ts. Imported here so
// internal callers within hook-utils can reference them, and re-exported
// so all hook scripts can keep importing from "./hook-utils.ts" unchanged.

import {
  getOpenPrForBranch,
  getRepoSlug,
  gh,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "../src/git-helpers.ts"

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
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

/** Resolve ~/.claude/tasks/<sessionId> for the active home directory. */
export function getSessionTasksDir(
  sessionId: string,
  home: string = process.env.HOME ?? ""
): string | null {
  if (!home || !sessionId) return null
  return join(home, ".claude", "tasks", sessionId)
}

/** Resolve ~/.claude/tasks/<sessionId>/<taskId>.json for task file access. */
export function getSessionTaskPath(
  sessionId: string,
  taskId: string,
  home: string = process.env.HOME ?? ""
): string | null {
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir || !taskId) return null
  return join(tasksDir, `${taskId}.json`)
}

/** True when a session task directory exists and can be listed. */
export async function hasSessionTasksDir(
  sessionId: string,
  home: string = process.env.HOME ?? ""
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
export { computeSubjectFingerprint, stemWord } from "../src/subject-fingerprint.ts"

import { computeSubjectFingerprint } from "../src/subject-fingerprint.ts"

/**
 * Read all task files for a session from ~/.claude/tasks/<sessionId>/.
 * Returns an empty array when the directory doesn't exist or can't be read.
 * Skips files that fail to parse or don't end with .json.
 */
export async function readSessionTasks(
  sessionId: string,
  home: string = process.env.HOME ?? ""
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
    if (!f.endsWith(".json") || f.startsWith(".")) continue
    try {
      const task = (await Bun.file(join(tasksDir, f)).json()) as SessionTask
      if (task.id && task.subject && task.status) {
        // Backfill fingerprint for tasks that predate the field
        if (!task.subjectFingerprint) {
          task.subjectFingerprint = computeSubjectFingerprint(task.subject)
        }
        tasks.push(task)
      }
    } catch {
      // skip unreadable or malformed task files
    }
  }
  return tasks
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
export async function findPriorSessionTasks(
  cwd: string,
  excludeSessionId: string,
  home: string = process.env.HOME ?? ""
): Promise<PriorSessionResult | null> {
  if (!home || !cwd) return null
  const { projectKeyFromCwd } = await import("../src/transcript-utils.ts")
  const { readdir, stat } = await import("node:fs/promises")

  const projectKey = projectKeyFromCwd(cwd)
  const projectDir = join(home, ".claude", "projects", projectKey)

  // Collect session IDs from transcript files (sorted by mtime, newest first)
  let transcriptFiles: string[]
  try {
    transcriptFiles = await readdir(projectDir)
  } catch {
    return null
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
  sessions.sort((a, b) => b.mtime - a.mtime)

  // Walk sessions newest-first; return incomplete tasks from first session with tasks
  for (const { id } of sessions) {
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

/**
 * Find the most recent index in `toolNames` that corresponds to any task tool.
 * Returns -1 when no task tool is present.
 */
export function findLastTaskToolCallIndex(toolNames: string[]): number {
  for (let i = toolNames.length - 1; i >= 0; i--) {
    const name = toolNames[i]
    if (name && TASK_TOOLS.has(name)) return i
  }
  return -1
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

/** Create a session task via `swiz tasks create`. Uses a sentinel file to fire only once per session. */
export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string,
  executor: TaskExecutor = defaultTaskExecutor
): Promise<void> {
  if (!sessionId || sessionId === "null" || !sessionId.trim()) return
  if (!sentinelKey.trim()) return
  const home = process.env.HOME
  if (!home) return
  // Sanitize sentinel path components: strip path separators and shell metacharacters
  const safeSentinel = sentinelKey.replace(/[^a-zA-Z0-9_-]/g, "")
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  if (!safeSentinel || !safeSession) return
  const sentinel = `/tmp/${safeSentinel}-${safeSession}.flag`
  if (await Bun.file(sentinel).exists()) return
  // Defensive: fall back to defaultTaskExecutor if the injected value is not callable.
  if (typeof executor !== "function") {
    console.error(
      `[swiz] createSessionTask: invalid executor (got ${typeof executor}), falling back to default`
    )
    executor = defaultTaskExecutor
  }
  const swiz = Bun.which("swiz") ?? join(home, ".bun", "bin", "swiz")
  const args = ["swiz", "tasks", "create", subject, description, "--session", sessionId]
  // Replace argv[0] with the resolved binary path so Bun.spawn can locate it.
  args[0] = swiz
  let exitCode: number
  try {
    exitCode = await executor(args)
  } catch (err) {
    // Injected executor threw — report and retry with the default.
    console.error(
      `[swiz] createSessionTask: executor threw (${err instanceof Error ? err.message : String(err)}), falling back to default`
    )
    try {
      exitCode = await defaultTaskExecutor(args)
    } catch (defaultErr) {
      console.error(
        `[swiz] createSessionTask: default executor also threw (${defaultErr instanceof Error ? defaultErr.message : String(defaultErr)}), giving up`
      )
      return
    }
  }
  if (exitCode === 0) {
    try {
      await Bun.write(sentinel, "")
    } catch {}
  }
}

// ─── Branch utilities ───────────────────────────────────────────────────

/** True if branch matches the configured default branch. */
export function isDefaultBranch(
  branch: string,
  defaultBranches: string | readonly string[] = ["main", "master"]
): boolean {
  const candidates = Array.isArray(defaultBranches) ? defaultBranches : [defaultBranches]
  return candidates.includes(branch)
}

/**
 * Resolve the effective default branch for a repository.
 * Precedence:
 *   1. Project setting `.swiz/config.json` → `defaultBranch`
 *   2. Git remote HEAD (`refs/remotes/origin/HEAD`)
 *   3. Local `main` branch
 *   4. Local `master` branch
 *   5. Fallback `main`
 */
export async function getDefaultBranch(cwd: string): Promise<string> {
  const projectSettings = await readProjectSettings(cwd)
  const configured = projectSettings?.defaultBranch?.trim()
  if (configured) return configured

  const remoteHeadRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)
  const remoteHead = remoteHeadRef.replace(/^refs\/remotes\/origin\//, "").trim()
  if (remoteHead) return remoteHead

  const localMain = await git(["rev-parse", "--verify", "refs/heads/main"], cwd)
  if (localMain) return "main"

  const localMaster = await git(["rev-parse", "--verify", "refs/heads/master"], cwd)
  if (localMaster) return "master"

  return "main"
}

// ─── Git status parsing ─────────────────────────────────────────────────

export interface GitStatusCounts {
  total: number
  modified: number
  added: number
  deleted: number
  untracked: number
  lines: string[]
}

/** Parse `git status --porcelain` output into a breakdown of file counts. */
export function parseGitStatus(porcelain: string): GitStatusCounts {
  const lines = porcelain.split("\n").filter((l) => l.trim())
  let modified = 0,
    added = 0,
    deleted = 0,
    untracked = 0
  for (const line of lines) {
    if (line.startsWith(" M")) modified++
    else if (line.startsWith("A ")) added++
    else if (line.startsWith("D ")) deleted++
    else if (line.startsWith("??")) untracked++
  }
  return { total: lines.length, modified, added, deleted, untracked, lines }
}

// ─── Git diff --stat summary parsing ────────────────────────────────────

export interface GitStatSummary {
  filesChanged: number
  insertions: number
  deletions: number
}

/**
 * Parse the summary line from `git diff --stat` output.
 *
 * Handles all variants:
 * - Both: "3 files changed, 160 insertions(+), 2 deletions(-)"
 * - Insertions only: "2 files changed, 21 insertions(+)"
 * - Deletions only: "1 file changed, 5 deletions(-)"
 * - Rename only: "1 file changed" (no insertions/deletions)
 * - Empty/no changes: returns zeros
 *
 * Pass the full `--stat` output; the function finds and parses
 * the summary line (last non-empty line matching "file(s) changed").
 */
export function parseGitStatSummary(statOutput: string): GitStatSummary {
  const lines = statOutput.trim().split("\n")

  // Find the summary line — last line matching "N file(s) changed"
  const summaryLine = lines.findLast((l) => /\d+\s+files?\s+changed/.test(l)) ?? ""
  if (!summaryLine) return { filesChanged: 0, insertions: 0, deletions: 0 }

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/)
  const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/)
  const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/)

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1]!, 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0,
  }
}

export interface ChangeScopeResult {
  /** True when --stat returned zero files but --name-only found changes */
  statParsingFailed: boolean
  isTrivial: boolean
  isSmallFix: boolean
  isDocsOnly: boolean
  scopeDescription: string
  fileCount: number
  totalLinesChanged: number
}

export interface ClassifyChangeScopeOptions {
  /** Override the max file count for trivial classification (default: 3) */
  trivialMaxFiles?: number
  /** Override the max line count for trivial classification (default: 20) */
  trivialMaxLines?: number
}

/**
 * Classify a set of changes as trivial, small-fix, docs-only, or non-trivial.
 *
 * Fail-closed: when stat parsing disagrees with the file list (fileCount === 0
 * but changedFiles is non-empty), forces non-trivial classification so the
 * caller blocks rather than allows.
 */
export function classifyChangeScope(
  stat: GitStatSummary,
  changedFiles: string[],
  options: ClassifyChangeScopeOptions = {}
): ChangeScopeResult {
  const { filesChanged: fileCount, insertions, deletions } = stat
  const totalLinesChanged = insertions + deletions
  const trivialMaxFiles = options.trivialMaxFiles ?? 3
  const trivialMaxLines = options.trivialMaxLines ?? 20

  // Fail-closed: stat returned zeros but files actually changed
  const statParsingFailed = changedFiles.length > 0 && fileCount === 0

  const docsOnlyRe =
    /\.(md|txt|rst)$|^(README|CHANGELOG|LICENSE|docs\/)|(\.config\.|\.json|\.yaml|\.yml|\.toml)$/i
  const isDocsOnly = changedFiles.length > 0 && changedFiles.every((f) => docsOnlyRe.test(f))

  const isTrivial =
    !statParsingFailed &&
    fileCount <= trivialMaxFiles &&
    totalLinesChanged <= trivialMaxLines &&
    !changedFiles.some((f) => /src\/|lib\/|components\//.test(f))

  const isSmallFix = !statParsingFailed && fileCount <= 2 && totalLinesChanged <= 30

  const scopeDescription = statParsingFailed
    ? `stat-unparseable (${changedFiles.length} files detected)`
    : isDocsOnly
      ? "docs-only"
      : isTrivial
        ? "trivial"
        : isSmallFix
          ? "small-fix"
          : `${fileCount}-files, ${totalLinesChanged}-lines`

  return {
    statParsingFailed,
    isTrivial,
    isSmallFix,
    isDocsOnly,
    scopeDescription,
    fileCount,
    totalLinesChanged,
  }
}

// ─── Git ahead/behind ───────────────────────────────────────────────────

/**
 * Return how many commits the current branch is ahead/behind its upstream,
 * plus the upstream ref name. Returns null if no upstream is set or counts
 * cannot be parsed.
 */
export async function getGitAheadBehind(
  cwd: string
): Promise<{ ahead: number; behind: number; upstream: string } | null> {
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd)
  if (!upstream) return null
  const ahead = parseInt(await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd), 10)
  const behind = parseInt(await git(["rev-list", "--count", "HEAD..@{upstream}"], cwd), 10)
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null
  return { ahead, behind, upstream }
}

// ─── Source file classification ─────────────────────────────────────────

/** Source file extensions worth scanning for code issues. */
export const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|php|cs|cpp|c|rs|vue|svelte)$/

/** Files that are tests — skip for debug/TODO checks. */
export const TEST_FILE_RE = /\.test\.|\.spec\.|__tests__|\/test\//

// ─── Transcript parsing ─────────────────────────────────────────────────

/**
 * Parse a Claude Code JSONL transcript and return every tool name called by
 * the assistant, in order. Returns [] if the file is missing or unreadable.
 */
export async function extractToolNamesFromTranscript(transcriptPath: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(transcriptPath)
  return blocks.flatMap((b) => (b.name ? [String(b.name)] : []))
}

// ─── Command normalisation (re-exported from src/) ──────────────────────
export { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
// ─── Transcript summary (re-exported from src/) ────────────────────────
export {
  computeTranscriptSummary,
  getTranscriptSummary,
  parseTranscriptSummary,
  type TranscriptSummary,
} from "../src/transcript-summary.ts"

import { normalizeCommand } from "../src/command-utils.ts"

/**
 * Read all `tool_use` blocks from assistant messages in a JSONL transcript.
 * Shared by the extract* helpers below to avoid duplicating the JSONL-parsing loop.
 */
async function readTranscriptToolBlocks(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await Bun.file(path).text()
    const blocks: Array<Record<string, unknown>> = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type === "tool_use") blocks.push(block)
        }
      } catch {}
    }
    return blocks
  } catch {
    return []
  }
}

/**
 * Extract all shell commands from assistant Bash tool_use blocks in a transcript.
 * Each command is normalised (backslash-newline continuations collapsed) before
 * being returned.
 */
export async function extractBashCommands(path: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(path)
  const commands: string[] = []
  for (const block of blocks) {
    if (!isShellTool(String(block.name ?? ""))) continue
    const cmd = String((block.input as Record<string, unknown>)?.command ?? "")
    if (cmd) commands.push(normalizeCommand(cmd))
  }
  return commands
}

/**
 * Extract the names of all skills invoked via the Skill tool in a transcript.
 * Returns an array of skill name strings (e.g. ["commit", "push"]).
 */
export async function extractSkillInvocations(path: string): Promise<string[]> {
  const blocks = await readTranscriptToolBlocks(path)
  const skills: string[] = []
  for (const block of blocks) {
    if (block.name !== "Skill") continue
    const skill = String((block.input as Record<string, unknown>)?.skill ?? "")
    if (skill) skills.push(skill)
  }
  return skills
}

// ── ANSI stripping ──────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string so regex pattern matching works on
 * real terminal output (bun test, biome, tsc, etc. embed colour codes).
 * Uses String.fromCharCode(27) to satisfy the no-control-regex lint rule.
 */
const _ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
export function stripAnsi(s: string): string {
  return s.replace(_ANSI_RE, "")
}

// ── Blocked tool_use detection ──────────────────────────────────────────────

/**
 * Collect the tool_use IDs of calls denied by a PreToolUse hook.
 *
 * When a PreToolUse hook blocks a tool call, Claude Code writes the assistant
 * message to the transcript before running the hook, but the corresponding
 * tool_result in the next user message contains the denial reason rather than
 * actual output. All hook denial messages end with the mandatory
 * `ACTION REQUIRED:` footer, which is the reliable detection signal.
 *
 * Pass the result to parseTranscriptEvents (or similar) to skip blocked entries
 * so they are not counted as actual executions.
 */
export function collectBlockedToolUseIds(lines: string[]): Set<string> {
  const blocked = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "user") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== "tool_result") continue
        const inner: unknown = block.content
        let text = ""
        if (typeof inner === "string") text = inner
        else if (Array.isArray(inner))
          text = (inner as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
        if (text.includes("ACTION REQUIRED:")) blocked.add(String(block.tool_use_id ?? ""))
      }
    } catch {
      // Ignore malformed lines
    }
  }
  return blocked
}

// ── Git command regexes ───────────────────────────────────────────────────

/** Matches `git push` anywhere in a shell command string. */
export const GIT_PUSH_RE = /(?:^|\n|;|&&|\|\|)\s*git\s+push\b/
/** Matches `git commit` anywhere in a shell command string. */
export const GIT_COMMIT_RE = /(?:^|\n|;|&&|\|\|)\s*git\s+commit\b/

/**
 * Matches git read-only subcommands.
 * Used with `!GIT_WRITE_RE.test(cmd)` to gate purely read-only git calls.
 */
export const GIT_READ_RE =
  /(?:^|\|\||&&|;)\s*git\s+(log|status|diff|show|branch|remote\b|rev-parse|rev-list|reflog|ls-files|describe|tag\b)(\s|$)/

/** Matches git subcommands that mutate state. */
export const GIT_WRITE_RE =
  /\bgit\s+(add|commit|push|pull|fetch|checkout|switch|restore|reset|rebase|merge|stash\s+(?!list)|cherry-pick|revert|rm|mv|apply)\b/

/** Matches `git push`, `git pull`, or `git fetch` — mechanical sync ops. */
export const GIT_SYNC_RE = /(?:^|\|\||&&|;)\s*git\s+(push|pull|fetch)\b/

/** Matches `git merge` anywhere in a shell command string (chain-boundary anchored). */
export const GIT_MERGE_RE = /(?:^|\|\||&&|;)\s*git\s+merge\b/

/** Matches `gh pr merge` anywhere in a shell command string (chain-boundary anchored). */
export const GH_PR_MERGE_RE = /(?:^|\|\||&&|;)\s*gh\s+pr\s+merge\b/

/**
 * Matches any `git` invocation in a shell command string.
 * Uses a broader boundary set (whitespace, pipe, semicolon, `&`) so it catches
 * git inside subshells and pipelines, not just shell chain operators.
 * Use for presence detection (e.g. lock-file checks); prefer the stricter
 * GIT_MERGE_RE / GIT_PUSH_RE etc. for command-type gating.
 */
export const GIT_ANY_CMD_RE = /(?:^|\s|[|;&])git\s/

/** Extract the PR number from a `gh pr merge <number>` command. */
export function extractPrNumber(command: string): string | null {
  const match = command.match(/gh\s+pr\s+merge\s+(\d+)/)
  return match?.[1] ?? null
}

/** Extract the branch name from a `git merge <branch>` command. */
export function extractMergeBranch(command: string): string | null {
  // Match `git merge <branch>`, skipping flags (--no-ff, --squash, etc.)
  const match = command.match(/git\s+merge\s+(?:--\S+\s+)*([^\s;|&]+)/)
  if (!match?.[1]) return null
  const branch = match[1]
  // Filter out flags that look like branches
  if (branch.startsWith("-")) return null
  return branch
}

/**
 * Matches any force-push flag on a `git push` command:
 *   --force, --force-with-lease, --force-with-lease=<ref>,
 *   --force-if-includes, -f, or combined short flags containing f (e.g. -fu).
 * Used by pretooluse-push-cooldown.ts to bypass the cooldown.
 */
export const FORCE_PUSH_RE =
  /\bgit\s+push\b.*(?:--force(?:-with-lease(?:=[^\s]+)?|-if-includes)?(?!\S)|-[a-zA-Z]*f)/

// ── Token-based git push argument parser ─────────────────────────────────────

/** Long force flags for git push (without = suffix). */
const FORCE_LONG_FLAG_NAMES = new Set(["--force", "--force-with-lease", "--force-if-includes"])

/** Git global options that consume the following token as their value. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--work-tree", "--git-dir", "--namespace"])

/** Returns true if a single parsed flag token is a force-push flag. */
function isGitPushForceToken(token: string): boolean {
  if (!token.startsWith("-")) return false
  if (token.startsWith("--")) {
    // Strip optional =<value> suffix before looking up the flag name
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
    return FORCE_LONG_FLAG_NAMES.has(name)
  }
  // Short flags: -f alone or combined like -fu
  return token.slice(1).includes("f")
}

/**
 * Minimal shell tokenizer — splits on unquoted whitespace, respects single
 * and double quotes and backslash escapes.  Returns a flat list of tokens.
 */
function shellTokenize(segment: string): string[] {
  const tokens: string[] = []
  let token = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      if (ch === quote) quote = null
      else token += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === "\\" && i + 1 < segment.length) {
      token += segment[++i]!
    } else if (ch === " " || ch === "\t") {
      if (token) {
        tokens.push(token)
        token = ""
      }
    } else {
      token += ch
    }
  }
  if (token) tokens.push(token)
  return tokens
}

/**
 * Token-based detection of force flags in a `git push` command.
 *
 * Handles edge cases that regex cannot:
 *   - `git push -- --force`   → `--force` is a refspec, NOT a flag (blocked correctly)
 *   - `git -C /path push -f`  → git global option before subcommand (detected correctly)
 *   - `git push origin --force main` → force flag between operands (detected correctly)
 *   - Chained commands via `&&`, `||`, `;`, newlines
 */
export function hasGitPushForceFlag(command: string): boolean {
  // Split on shell command separators to process each command in a chain
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const segment of segments) {
    const tokens = shellTokenize(segment)
    let i = 0

    while (i < tokens.length) {
      if (tokens[i] !== "git") {
        i++
        continue
      }
      i++ // skip "git"

      // Skip git's own global options before the subcommand (e.g. -C <dir>, -c key=val).
      // Options that consume the next token as a value are listed in GIT_VALUE_OPTS.
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        if (GIT_VALUE_OPTS.has(tokens[i]!)) i++ // skip the value token
        i++
      }

      if (tokens[i] !== "push") continue
      i++ // skip "push"

      // Walk git push flags, respecting the -- end-of-flags sentinel
      let endOfFlags = false
      while (i < tokens.length) {
        const t = tokens[i]!
        i++
        if (t === "--") {
          endOfFlags = true
          continue
        }
        if (!endOfFlags && isGitPushForceToken(t)) return true
      }
    }
  }
  return false
}

/** Matches `ls`, `rg`, or `grep` — pure read commands. */
export const READ_CMD_RE = /(?:^|\|\||&&|;)\s*(ls|rg|grep)\b/

/** Matches any `gh` CLI invocation. */
export const GH_CMD_RE = /(?:^|\|\||&&|;)\s*gh\b/

/** Matches `swiz issue close` or `swiz issue comment` — thin gh-issue wrappers. */
export const SWIZ_ISSUE_RE = /(?:^|\|\||&&|;)\s*swiz\s+issue\s+(close|comment)\b/

/** Matches CI verification commands: `swiz ci-wait`, `bun ... ci-wait`, `bun run index.ts ci-wait`. */
export const CI_WAIT_RE = /(?:^|\|\||&&|;)\s*(?:swiz|bun\b[^|;]*)\s+ci-wait\b/

/** True when a shell command is exempt from task-tracking enforcement. */
export function isTaskTrackingExemptShellCommand(command: string): boolean {
  return (
    (GIT_READ_RE.test(command) && !GIT_WRITE_RE.test(command)) ||
    READ_CMD_RE.test(command) ||
    GIT_SYNC_RE.test(command) ||
    GH_CMD_RE.test(command) ||
    SWIZ_CMD_RE.test(command)
  )
}

// ── Push-gate check regexes ───────────────────────────────────────────────

/**
 * Matches `git branch --show-current` (exact flag, no suffix like -upstream).
 * (?!\S) ensures `--show-current` is the last token, not a prefix of another flag.
 */
export const BRANCH_CHECK_RE = /\bgit\s+branch\s+--show-current(?!\S)/

/** Matches `gh pr list --head` (open-PR check). */
export const PR_CHECK_RE = /\bgh\s+pr\s+list\b.*--head\b/

// ─── GitHub identity ────────────────────────────────────────────────────

/**
 * Extract the repository owner login from a git remote URL.
 * Handles both SSH (`git@github.com:owner/repo.git`) and
 * HTTPS (`https://github.com/owner/repo.git`) formats.
 * Returns `null` for non-GitHub remotes or unrecognised formats.
 */
export function extractOwnerFromUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\//)
  if (sshMatch?.[1]) return sshMatch[1]

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//)
  if (httpsMatch?.[1]) return httpsMatch[1]

  return null
}

/**
 * Return the login of the currently-authenticated GitHub user via
 * `gh api user --jq .login`. Returns `null` when the `gh` CLI is
 * unavailable or unauthenticated.
 */
export async function getCurrentGitHubUser(cwd: string): Promise<string | null> {
  const login = await gh(["api", "user", "--jq", ".login"], cwd)
  return login || null
}

/**
 * Return the `owner/repo` slug for the GitHub remote at `cwd` via
 * `gh repo view --json nameWithOwner`. Returns `null` when the `gh`
 * CLI is unavailable or the directory is not a GitHub-backed repo.
 */
export async function getRepoNameWithOwner(cwd: string): Promise<string | null> {
  const name = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)
  return name || null
}

// Re-exported from src/git-helpers.ts
export { issueState } from "../src/git-helpers.ts"

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

/**
 * Shared speak invocation helper. Resolves the speak.ts path, builds narrator
 * CLI args from settings, pipes `text` to stdin, and awaits completion.
 *
 * @param text            Text to speak (piped to speak.ts via stdin).
 * @param settings        Object with `narratorVoice` and `narratorSpeed` fields.
 * @param speakScriptPath Absolute path to speak.ts. Defaults to sibling speak.ts
 *                        next to hook-utils.ts (hooks/ directory).
 */
export async function spawnSpeak(
  text: string,
  settings: { narratorVoice: string; narratorSpeed: number },
  speakScriptPath?: string
): Promise<void> {
  const scriptPath = speakScriptPath ?? join(dirname(import.meta.path), "speak.ts")
  const speakArgs = ["bun", scriptPath]
  if (settings.narratorVoice) speakArgs.push("--voice", settings.narratorVoice)
  if (settings.narratorSpeed > 0) speakArgs.push("--speed", String(settings.narratorSpeed))
  try {
    const proc = Bun.spawn(speakArgs, {
      stdin: new Response(text).body!,
      stderr: "pipe",
    })
    await new Response(proc.stderr).text()
    await proc.exited
  } catch {
    // Silent failure — TTS errors must not affect hook behaviour
  }
}

// ─── File utilities ───────────────────────────────────────────────────────

/**
 * Count words in a file, handling edge cases like BOM, CRLF, Unicode, binary files.
 * Returns null if file is binary, doesn't exist, or can't be read.
 * Returns { words, lines, chars } for text files.
 */
export async function countFileWords(
  path: string
): Promise<{ words: number; lines: number; chars: number } | null> {
  try {
    // Check if file exists using statSync
    const { statSync } = await import("node:fs")
    try {
      statSync(path)
    } catch {
      return null // File doesn't exist
    }

    const file = Bun.file(path)
    const size = file.size

    // Empty file edge case
    if (size === 0) {
      return { words: 0, lines: 0, chars: 0 }
    }

    // Guard against binary files: check first 512 bytes for null bytes
    const headerBuffer = await file.slice(0, 512).arrayBuffer()
    const headerView = new Uint8Array(headerBuffer)
    if (headerView.includes(0)) return null // Binary file detected

    // Read and parse file for stats
    const content = await file.text()
    const chars = content.length

    // Count lines (handle CRLF and LF)
    let lines = 0
    let words = 0
    let inWord = false

    for (let i = 0; i < content.length; i++) {
      const char = content.charAt(i)

      // Line counting: count newlines, add 1 if content doesn't end with newline
      if (char === "\n") {
        lines++
      }

      // Word counting: track whitespace boundaries
      const isWhitespace = /\s/.test(char)
      if (!isWhitespace && !inWord) {
        words++
        inWord = true
      } else if (isWhitespace) {
        inWord = false
      }
    }

    // If file doesn't end with newline, add 1 to line count
    if (content.length > 0 && content[content.length - 1] !== "\n") {
      lines++
    }

    return { words, lines, chars }
  } catch {
    return null
  }
}
