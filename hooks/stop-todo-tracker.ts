#!/usr/bin/env bun

// Stop hook: File follow-up issues for new TODO/FIXME/HACK lines introduced in commits.
// Instead of blocking stop, auto-creates GitHub issues for each finding and allows stop.

import { stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  fileFollowUpIssue,
  git,
  isGitRepo,
  SOURCE_EXT_RE,
  sanitizeSessionId,
} from "./utils/hook-utils.ts"

export const EXCLUDE_PATH_RE = /node_modules|\.claude\/hooks\/|^hooks\/|__tests__|\.test\.|\.spec\./
export const GENERATED_FILE_RE = /main\.dart\.js$|\.dart\.js$|\.min\.js$|\.bundle\.js$|\.chunk\.js$/
const TODO_RE = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/i
const COMMENT_RE = /(\/[/*]|#\s)/
const REGEX_LITERAL_RE = /^\s*\/[^/]/ // line content starts with regex literal

function isExcludedFile(f: string): boolean {
  return !SOURCE_EXT_RE.test(f) || EXCLUDE_PATH_RE.test(f) || GENERATED_FILE_RE.test(f)
}

function scanDiffForTodos(diff: string): string[] {
  const todos: string[] = []
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const content = line.slice(1)
    if (!TODO_RE.test(content)) continue
    if (REGEX_LITERAL_RE.test(content)) continue
    if (!COMMENT_RE.test(content)) continue
    todos.push(line.slice(0, 150))
    if (todos.length >= 15) break
  }
  return todos
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  // Use HEAD~10 as the diff base when available; fall back to the git empty-tree
  // SHA so the range resolves correctly in repos with fewer than 11 commits.
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const base = (await git(["rev-parse", "--verify", "HEAD~10"], cwd)) || GIT_EMPTY_TREE
  const range = `${base}..HEAD`

  // Only scan recognised source code files
  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return

  const sourceFiles = changedRaw.split("\n").filter((f) => !isExcludedFile(f))

  if (sourceFiles.length === 0) return

  const diff = await git(["diff", range, "--", ...sourceFiles], cwd)
  if (!diff) return

  const todos = scanDiffForTodos(diff)

  if (todos.length === 0) return

  const sessionId = sanitizeSessionId(input.session_id)

  let reason = `${todos.length} new TODO/FIXME/HACK comment(s) introduced in recent commits.\n\n`
  reason += "Items:\n"
  for (const t of todos) reason += `  ${t}\n`

  // Auto-file a follow-up issue instead of blocking stop.
  // If filing fails, fileFollowUpIssue falls back to blockStop.
  const issueBody = [
    `${todos.length} TODO/FIXME/HACK comment(s) found in recent commits:`,
    "",
    ...todos.map((t) => `- \`${t.trim()}\``),
    "",
    "These should be resolved or converted to tracked issues.",
  ].join("\n")

  const issueNum = await fileFollowUpIssue(
    {
      title: `chore: resolve ${todos.length} TODO/FIXME comment(s)`,
      body: issueBody,
      labels: ["backlog", "maintenance"],
      cwd,
      sessionId,
    },
    reason
  )

  if (issueNum) {
    console.error(
      `[swiz][stop-todo-tracker] Filed follow-up issue #${issueNum} for ${todos.length} TODO(s)`
    )
    // Allow stop — finding is captured as a tracked issue
    return
  }

  // Fallback: fileFollowUpIssue calls blockStop on failure, but if it somehow
  // returns null without blocking, block explicitly.
  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
