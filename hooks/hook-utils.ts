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

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { translateMatcher } from "../src/agents.ts"
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "../src/detect.ts"
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
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
      _pmCache = "bun"
      return _pmCache
    }
    if (existsSync(join(dir, "pnpm-lock.yaml"))) {
      _pmCache = "pnpm"
      return _pmCache
    }
    if (existsSync(join(dir, "yarn.lock"))) {
      _pmCache = "yarn"
      return _pmCache
    }
    if (existsSync(join(dir, "package-lock.json"))) {
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
// tasks-list verifyTaskMatch (exempts placeholders from subject verification).
// All auto-generated placeholder subjects must be captured here so both
// validators stay in sync.

/**
 * Matches all auto-generated placeholder task subjects:
 *   - "Recovered task #N (lost during compaction)" — pretooluse-task-recovery / posttooluse-task-recovery
 *   - "Session bootstrap — describe current work"  — pretooluse-require-tasks
 */
export const PLACEHOLDER_SUBJECT_RE = /^(?:recovered task|session bootstrap)\b/i

/** Returns true if the subject is an auto-generated placeholder (not real agent work). */
export function isPlaceholderSubject(subject: string): boolean {
  return PLACEHOLDER_SUBJECT_RE.test(subject.trim())
}

// ─── Hook response helpers ─────────────────────────────────────────────────
// Outputs polyglot JSON understood by Claude Code, Cursor, Gemini CLI, and Codex CLI.

/** Emit a PreToolUse denial and exit. Appends ACTION REQUIRED footer. Works across all agents. */
export function denyPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason + preToolActionRequired(reason),
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

/** Emit additional context for a hook event. Works across all agents. */
export function emitContext(eventName: string, context: string): never {
  console.log(
    JSON.stringify({
      systemMessage: context,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    })
  )
  process.exit(0)
}

// ─── Stop hook helpers ────────────────────────────────────────────────────

/**
 * Format a numbered action plan for inclusion in stop hook block reasons.
 * Returns an "Action plan:\n  1. ...\n  2. ..." block ready to append to a reason string.
 * When requested, canonical tool names (for example "TaskCreate") are
 * translated to the current agent's tool alias before rendering.
 */
export function formatActionPlan(
  steps: string[],
  options?: { translateToolNames?: boolean }
): string {
  if (steps.length === 0) return ""
  const agent = options?.translateToolNames ? detectCurrentAgent() : null
  const renderedSteps = agent ? steps.map((step) => translateMatcher(step, agent) ?? step) : steps
  const numbered = renderedSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
  return `Action plan:\n${numbered}\n`
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

/** Standard ACTION REQUIRED footer for PreToolUse denials. */
export function preToolActionRequired(reason = ""): string {
  const reassess = skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
  const updateMemory = updateMemoryAdvice(reason)
  return `\n\nACTION REQUIRED: Fix the underlying issue before retrying. This hook will deny this tool call every time this violation is present. Do not attempt to bypass or work around it — address the root cause.\n\n${reassess}\n\n${updateMemory}`
}

/** Standard ACTION REQUIRED footer appended to all stop hook block reasons. */
export function actionRequired(
  reason = "",
  options: { includeUpdateMemoryAdvice?: boolean } = {}
): string {
  const { includeUpdateMemoryAdvice = true } = options
  const reassess = skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
  const updateMemory = includeUpdateMemoryAdvice ? `\n\n${updateMemoryAdvice(reason)}` : ""
  return `\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action.\n\n${reassess}${updateMemory}`
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
  if (!home || !sessionId) return []
  const tasksDir = join(home, ".claude", "tasks", sessionId)
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
    const incomplete = tasks.filter((t) => isIncompleteTaskStatus(t.status))
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

/** Create a session task via tasks-list.ts. Uses a sentinel file to fire only once per session. */
export async function createSessionTask(
  sessionId: string | undefined,
  sentinelKey: string,
  subject: string,
  description: string
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
  try {
    const proc = Bun.spawn(
      [
        "bun",
        join(home, ".claude", "hooks", "tasks-list.ts"),
        "--session",
        sessionId,
        "--create",
        subject,
        description,
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    await proc.exited
    if (proc.exitCode === 0) {
      await Bun.write(sentinel, "")
    }
  } catch {}
}

// ─── Branch utilities ───────────────────────────────────────────────────

/** True if branch is the default integration branch (main or master). */
export function isDefaultBranch(branch: string): boolean {
  return branch === "main" || branch === "master"
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
  let summaryLine = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\d+\s+files?\s+changed/.test(lines[i]!)) {
      summaryLine = lines[i]!
      break
    }
  }

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
  try {
    const text = await Bun.file(transcriptPath).text()
    const toolNames: string[] = []
    for (const line of text.split("\n").filter((l) => l.trim())) {
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type === "tool_use" && block?.name) {
            toolNames.push(block.name)
          }
        }
      } catch {}
    }
    return toolNames
  } catch {
    return []
  }
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
 * Extract all shell commands from assistant Bash tool_use blocks in a transcript.
 * Each command is normalised (backslash-newline continuations collapsed) before
 * being returned.
 */
export async function extractBashCommands(path: string): Promise<string[]> {
  const commands: string[] = []
  try {
    const text = await Bun.file(path).text()
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== "tool_use") continue
          if (!isShellTool(block?.name ?? "")) continue
          const cmd: string = block?.input?.command ?? ""
          if (cmd) commands.push(normalizeCommand(cmd))
        }
      } catch {}
    }
  } catch {}
  return commands
}

/**
 * Extract the names of all skills invoked via the Skill tool in a transcript.
 * Returns an array of skill name strings (e.g. ["commit", "push"]).
 */
export async function extractSkillInvocations(path: string): Promise<string[]> {
  const skills: string[] = []
  try {
    const text = await Bun.file(path).text()
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== "tool_use") continue
          if (block?.name !== "Skill") continue
          const skill: string = block?.input?.skill ?? ""
          if (skill) skills.push(skill)
        }
      } catch {}
    }
  } catch {}
  return skills
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
      // Options that consume the next token as a value are listed explicitly.
      const GIT_VALUE_OPTS = new Set(["-C", "-c", "--work-tree", "--git-dir", "--namespace"])
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
  cwd: string
  session_id?: string
  stop_hook_active?: boolean
  transcript_path?: string
}

export interface ToolHookInput {
  cwd: string
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  transcript_path?: string
}

export interface SessionHookInput {
  cwd: string
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
