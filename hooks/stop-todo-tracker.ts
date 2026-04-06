#!/usr/bin/env bun

// Stop hook: File follow-up issues for new TODO/FIXME/HACK lines introduced in commits.
// Instead of blocking stop, auto-creates GitHub issues for each finding and allows stop.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  blockStopObj,
  git,
  isGitRepo,
  SOURCE_EXT_RE,
  sanitizeSessionId,
  tryFileFollowUpIssue,
} from "../src/utils/hook-utils.ts"

export const EXCLUDE_PATH_RE = /node_modules|\.claude\/hooks\/|^hooks\/|__tests__|\.test\.|\.spec\./
export const GENERATED_FILE_RE = /main\.dart\.js$|\.dart\.js$|\.min\.js$|\.bundle\.js$|\.chunk\.js$/

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/i
const COMMENT_RE = /(\/[/*]|#\s)/
const REGEX_LITERAL_RE = /^\s*\/[^/]/

function isExcludedFile(f: string): boolean {
  return !SOURCE_EXT_RE.test(f) || EXCLUDE_PATH_RE.test(f) || GENERATED_FILE_RE.test(f)
}

function scanDiffForTodos(diff: string): string[] {
  const todos: string[] = []
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const content = line.slice(1)
    if (!TODO_RE.test(content)) continue
    const normalized = content.normalize("NFKC")
    if (REGEX_LITERAL_RE.test(normalized)) continue
    if (!COMMENT_RE.test(normalized)) continue
    todos.push(line.slice(0, 150))
    if (todos.length >= 15) break
  }
  return todos
}

export async function evaluateStopTodoTracker(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const base = (await git(["rev-parse", "--verify", "HEAD~10"], cwd)) || GIT_EMPTY_TREE
  const range = `${base}..HEAD`

  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return {}

  const sourceFiles = changedRaw.split("\n").filter((f) => !isExcludedFile(f))

  if (sourceFiles.length === 0) return {}

  const diff = await git(["diff", range, "--", ...sourceFiles], cwd)
  if (!diff) return {}

  const todos = scanDiffForTodos(diff)

  if (todos.length === 0) return {}

  const sessionId = sanitizeSessionId(parsed.session_id)

  let reason = `${todos.length} new TODO/FIXME/HACK comment(s) introduced in recent commits.\n\n`
  reason += "Items:\n"
  for (const t of todos) reason += `  ${t}\n`

  const issueBody = [
    `${todos.length} TODO/FIXME/HACK comment(s) found in recent commits:`,
    "",
    ...todos.map((t) => `- \`${t.trim()}\``),
    "",
    "These should be resolved or converted to tracked issues.",
  ].join("\n")

  // Fire-and-forget: issue creation is best-effort and must not consume the
  // hook's remaining timeout budget. The primary contract is surfacing TODOs
  // in the stop response — if gh is slow, findings are still reported.
  tryFileFollowUpIssue(
    {
      title: `chore: resolve ${todos.length} TODO/FIXME comment(s)`,
      body: issueBody,
      labels: ["backlog", "maintenance"],
      cwd,
      sessionId,
    },
    reason
  )
    .then((r) => {
      if (r.status === "filed" && r.issueNum) {
        console.error(
          `[swiz][stop-todo-tracker] Filed follow-up issue #${r.issueNum} for ${todos.length} TODO(s)`
        )
      }
    })
    .catch(() => {
      // Silent — issue creation is best-effort
    })

  return blockStopObj(reason)
}

const stopTodoTracker: SwizStopHook = {
  name: "stop-todo-tracker",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopTodoTracker(input)
  },
}

export default stopTodoTracker

if (import.meta.main) {
  await runSwizHookAsMain(stopTodoTracker)
}
