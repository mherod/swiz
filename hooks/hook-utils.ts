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

import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { translateMatcher } from "../src/agents.ts"
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "../src/detect.ts"
import { skillAdvice, skillExists } from "../src/skill-utils.ts"

export { skillAdvice, skillExists }
export { detectCurrentAgent, isCurrentAgent, isRunningInAgent }

// ─── Canonical path hashing utility ────────────────────────────────────────
// Shared by all cache-key generation in hooks and commands to ensure consistent
// behavior across symlink aliases, relative paths, and other path variants.

/**
 * Generate a canonical hash for a filesystem path.
 * Uses realpathSync() to dereference symlinks, ensuring equivalent repos
 * (accessed via symlink or real path) generate identical hashes.
 * Returns the full untruncated hash to avoid collision vulnerabilities.
 *
 * Usage:
 *   const hash = getCanonicalPathHash(cwd)
 *   const cooldownKey = `${sessionId}-${hash}`
 *   const cooldownFile = `/tmp/myapp-${cooldownKey}.sentinel`
 */
export function getCanonicalPathHash(cwd: string): string {
  // Canonicalize the path using realpath to dereference symlinks.
  // This ensures /path/to/repo and /symlink/to/repo generate the same hash.
  let realPath: string
  try {
    realPath = realpathSync(cwd)
  } catch {
    // If realpath fails (e.g., path doesn't exist), fall back to the original path.
    // This ensures the function is defensive and doesn't crash on edge cases.
    realPath = cwd
  }
  // Hash the canonical path without truncation to avoid collisions.
  const fullHash = Bun.hash(realPath).toString(16)
  return fullHash
}

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

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
// Bash        | Shell        | run_shell_command  | shell / shell_command / exec_command
// Edit        | StrReplace   | replace            | apply_patch
// Write       | Write        | write_file         | apply_patch
// Read        | Read         | read_file          | read_file
// Grep        | Grep         | grep_search        | grep_files
// Glob        | Glob         | glob               | list_dir
// NotebookEdit| EditNotebook | —                  | apply_patch
// TaskCreate  | TodoWrite    | write_todos        | update_plan

export const SHELL_TOOLS = new Set([
  "Bash",
  "Shell",
  "run_shell_command",
  "shell",
  "shell_command",
  "exec_command",
])
export const EDIT_TOOLS = new Set(["Edit", "StrReplace", "replace", "apply_patch"])
export const WRITE_TOOLS = new Set(["Write", "write_file", "apply_patch"])
export const READ_TOOLS = new Set(["Read", "read_file", "read_many_files"])
export const NOTEBOOK_TOOLS = new Set(["NotebookEdit", "EditNotebook", "apply_patch"])
export const TASK_TOOLS = new Set([
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "write_todos",
  "update_plan",
])
export const TASK_CREATE_TOOLS = new Set(["TaskCreate", "TodoWrite", "write_todos", "update_plan"])
export const SEARCH_TOOLS = new Set([
  "Grep",
  "Glob",
  "grep_search",
  "glob",
  "grep_files",
  "list_dir",
])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name)
}
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}
export function isNotebookTool(name: string): boolean {
  return NOTEBOOK_TOOLS.has(name)
}
export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.has(name)
}
export function isTaskCreateTool(name: string): boolean {
  return TASK_CREATE_TOOLS.has(name)
}
export function isFileEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)
}
export function isCodeChangeTool(name: string): boolean {
  return EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name) || NOTEBOOK_TOOLS.has(name)
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
export function actionRequired(reason = ""): string {
  const reassess = skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
  const updateMemory = updateMemoryAdvice(reason)
  return `\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action.\n\n${reassess}\n\n${updateMemory}`
}

/** Emit a stop block decision and exit. Appends ACTION_REQUIRED footer. */
export function blockStop(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason: reason + actionRequired(reason) }))
  process.exit(0)
}

/** Emit a raw stop block (no footer appended — caller controls the full reason). */
export function blockStopRaw(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason }))
  process.exit(0)
}

// ─── Git / CLI helpers ──────────────────────────────────────────────────

/** Run a git command and return trimmed stdout. Returns "" on non-zero exit or error. */
export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = cwd.trim() || process.cwd()
    const proc = Bun.spawn(["git", ...args], { cwd: effectiveCwd, stdout: "pipe", stderr: "pipe" })
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
}

/** Run a gh CLI command and return trimmed stdout. Returns "" on failure or timeout (3s). */
export async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = cwd.trim() || process.cwd()
    const proc = Bun.spawn(["gh", ...args], { cwd: effectiveCwd, stdout: "pipe", stderr: "pipe" })
    let killed = false
    const killTimer = setTimeout(() => {
      killed = true
      proc.kill()
    }, 3000)
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(killTimer)
    return !killed && proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
}

/** Run a gh CLI command and parse JSON output. Returns null on failure or invalid JSON. */
export async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
  const output = await gh(args, cwd)
  if (!output) return null
  try {
    return JSON.parse(output) as T
  } catch {
    return null
  }
}

/** Find the first open PR for a branch and return the requested JSON fields. */
export async function getOpenPrForBranch<T>(
  branch: string,
  cwd: string,
  jsonFields: string
): Promise<T | null> {
  if (!branch) return null
  const prs = await ghJson<T[]>(
    ["pr", "list", "--head", branch, "--state", "open", "--json", jsonFields],
    cwd
  )
  return prs?.[0] ?? null
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(["rev-parse", "--git-dir"], cwd)) !== ""
}

export async function isGitHubRemote(cwd: string): Promise<boolean> {
  const url = await git(["remote", "get-url", "origin"], cwd)
  return url.includes("github.com")
}

export function hasGhCli(): boolean {
  return !!Bun.which("gh")
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
}

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
      if (task.id && task.subject && task.status) tasks.push(task)
    } catch {
      // skip unreadable or malformed task files
    }
  }
  return tasks
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

/**
 * Classify a set of changes as trivial, small-fix, docs-only, or non-trivial.
 *
 * Fail-closed: when stat parsing disagrees with the file list (fileCount === 0
 * but changedFiles is non-empty), forces non-trivial classification so the
 * caller blocks rather than allows.
 */
export function classifyChangeScope(
  stat: GitStatSummary,
  changedFiles: string[]
): ChangeScopeResult {
  const { filesChanged: fileCount, insertions, deletions } = stat
  const totalLinesChanged = insertions + deletions

  // Fail-closed: stat returned zeros but files actually changed
  const statParsingFailed = changedFiles.length > 0 && fileCount === 0

  const docsOnlyRe =
    /\.(md|txt|rst)$|^(README|CHANGELOG|LICENSE|docs\/)|(\.config\.|\.json|\.yaml|\.yml|\.toml)$/i
  const isDocsOnly = changedFiles.length > 0 && changedFiles.every((f) => docsOnlyRe.test(f))

  const isTrivial =
    !statParsingFailed &&
    fileCount <= 3 &&
    totalLinesChanged <= 20 &&
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

// ─── Shared transcript summary ──────────────────────────────────────────
// Single-pass parser that extracts all derived facts hooks need from a
// transcript JSONL file. dispatch.ts computes this once per cycle and
// injects it into hook payloads as `_transcriptSummary`.

/**
 * Pre-parsed transcript summary injected by dispatch.ts into hook payloads.
 * Hooks should prefer consuming this over re-reading transcript_path.
 */
export interface TranscriptSummary {
  /** Every tool name called by the assistant, in order. */
  toolNames: string[]
  /** Total number of tool_use blocks (same as toolNames.length). */
  toolCallCount: number
  /** Normalized shell commands from Bash/Shell tool calls. */
  bashCommands: string[]
  /** Skill names invoked via the Skill tool. */
  skillInvocations: string[]
  /** Whether any Bash tool call contains `git push`. */
  hasGitPush: boolean
}

const GIT_PUSH_PATTERN = /\bgit\s+push\b/

/**
 * Parse a transcript JSONL string in a single pass and extract all derived
 * facts that hooks need. Returns a TranscriptSummary.
 */
export function parseTranscriptSummary(jsonlText: string): TranscriptSummary {
  const toolNames: string[] = []
  const bashCommands: string[] = []
  const skillInvocations: string[] = []
  let hasGitPush = false

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== "tool_use") continue
        const name: string = block?.name ?? ""
        if (name) toolNames.push(name)

        // Extract bash commands
        if (isShellTool(name)) {
          const cmd: string = block?.input?.command ?? ""
          if (cmd) {
            bashCommands.push(normalizeCommand(cmd))
            if (!hasGitPush && GIT_PUSH_PATTERN.test(cmd)) hasGitPush = true
          }
        }

        // Extract skill invocations
        if (name === "Skill") {
          const skill: string = block?.input?.skill ?? ""
          if (skill) skillInvocations.push(skill)
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    toolNames,
    toolCallCount: toolNames.length,
    bashCommands,
    skillInvocations,
    hasGitPush,
  }
}

/**
 * Read a transcript file and compute the summary. Returns null if the file
 * is missing or unreadable.
 */
export async function computeTranscriptSummary(
  transcriptPath: string
): Promise<TranscriptSummary | null> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return parseTranscriptSummary(text)
  } catch {
    return null
  }
}

/**
 * Extract the TranscriptSummary from a hook input payload (injected by dispatch).
 * Returns null if the summary is not present.
 */
export function getTranscriptSummary(input: Record<string, unknown>): TranscriptSummary | null {
  const summary = input?._transcriptSummary
  if (!summary || typeof summary !== "object") return null
  const s = summary as Record<string, unknown>
  if (!Array.isArray(s.toolNames)) return null
  return summary as TranscriptSummary
}

// ─── Command normalisation & matching ───────────────────────────────────
//
// Utilities for parsing and classifying shell commands in hook scripts.
// Centralised here so all hooks use the same patterns and normalisation steps.

/**
 * Normalize shell backslash-newline continuations so that
 *   git branch \<newline>  --show-current
 * is treated identically to
 *   git branch --show-current
 * before the regex checks run.
 */
export function normalizeCommand(cmd: string): string {
  // \r?\n handles both LF and CRLF line endings in backslash continuations
  return cmd.replace(/\\\r?\n\s*/g, " ")
}

/**
 * Strip heredoc bodies from a shell command string before regex matching.
 * Prevents false positives when git push/commit appears inside a heredoc body
 * rather than as an executable command.
 * Handles: <<WORD, <<-WORD, <<"WORD", <<'WORD'
 */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?[ \t]*["']?(\w+)["']?[ \t]*\n[\s\S]*?\n[ \t]*\1(?=\n|$)/g, "")
}

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
    SWIZ_ISSUE_RE.test(command) ||
    CI_WAIT_RE.test(command)
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

/**
 * Return the open/closed state of a GitHub issue, or `null` when the `gh`
 * CLI is unavailable or the issue cannot be found.
 *
 * Use this before posting a comment or closing an issue to avoid redundant
 * operations and the confusing error output they produce.
 *
 * @example
 * const state = await issueState(19, cwd)
 * if (state !== "OPEN") { console.log(`#19 already ${state ?? "unknown"} — skipping`); return }
 * await gh(["issue", "comment", "19", "--body", body], cwd)
 * await gh(["issue", "close", "19"], cwd)
 */
export async function issueState(
  issueNumber: number | string,
  cwd: string
): Promise<"OPEN" | "CLOSED" | null> {
  const raw = await gh(
    ["issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"],
    cwd
  )
  if (raw === "OPEN" || raw === "CLOSED") return raw
  return null
}

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
