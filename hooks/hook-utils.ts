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
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "../src/detect.ts"
import { skillAdvice, skillExists } from "../src/skill-utils.ts"

export { skillAdvice, skillExists }
export { detectCurrentAgent, isCurrentAgent, isRunningInAgent }

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

// ─── Hook response helpers ─────────────────────────────────────────────────
// Outputs polyglot JSON understood by Claude Code, Cursor, Gemini CLI, and Codex CLI.

/** Emit a PreToolUse denial and exit. Appends ACTION REQUIRED footer. Works across all agents. */
export function denyPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason + preToolActionRequired(),
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
 */
export function formatActionPlan(steps: string[]): string {
  if (steps.length === 0) return ""
  const numbered = steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
  return `Action plan:\n${numbered}\n`
}

/** Standard ACTION REQUIRED footer for PreToolUse denials. */
export function preToolActionRequired(): string {
  const reassess = skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
  const updateMemory = skillAdvice(
    "update-memory",
    "Use the /update-memory skill to record a DO or DON'T rule that proactively builds the required steps into your standard development workflow.",
    "Update your MEMORY.md with a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
  )
  return `\n\nACTION REQUIRED: Fix the underlying issue before retrying. This hook will deny this tool call every time this violation is present. Do not attempt to bypass or work around it — address the root cause.\n\n${reassess}\n\n${updateMemory}`
}

/** Standard ACTION REQUIRED footer appended to all stop hook block reasons. */
export function actionRequired(): string {
  const reassess = skillAdvice(
    "re-assess",
    "If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment.",
    "If you believe this is a false positive, re-evaluate your assumptions carefully before retrying — the hook's findings take authority over your own assessment."
  )
  const updateMemory = skillAdvice(
    "update-memory",
    "Use the /update-memory skill to record a DO or DON'T rule that proactively builds the required steps into your standard development workflow.",
    "Update your MEMORY.md with a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
  )
  return `\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action.\n\n${reassess}\n\n${updateMemory}`
}

/** Emit a stop block decision and exit. Appends ACTION_REQUIRED footer. */
export function blockStop(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason: reason + actionRequired() }))
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
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
}

/** Run a gh CLI command and return trimmed stdout. Returns "" on failure. */
export async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = cwd.trim() || process.cwd()
    const proc = Bun.spawn(["gh", ...args], { cwd: effectiveCwd, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
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
    await Bun.write(sentinel, "")
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
