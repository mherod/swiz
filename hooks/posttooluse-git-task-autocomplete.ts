#!/usr/bin/env bun
/**
 * PostToolUse hook: Auto-complete Commit/Push tasks after git operations
 *
 * After a successful `git commit` or `git push` Bash call, scans the session's
 * task files and marks any pending/in_progress task whose subject contains
 * "Commit" or "Push" (case-insensitive) as completed.
 *
 * After a push, emits additionalContext reminding the agent to create a
 * "Wait for CI and verify pass" task — the only way to affect Claude's
 * in-memory task list is via the hook output channel, not filesystem writes.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  GIT_COMMIT_RE,
  GIT_PUSH_RE,
  isShellTool,
  readSessionTasks,
  stripHeredocs,
  type ToolHookInput,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

const SUBJECT_RE = /\b(commit|push)\b/i

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  if (!input.session_id) return
  if (!input.tool_name || !isShellTool(input.tool_name)) return

  const command = stripHeredocs(String(input.tool_input?.command ?? ""))
  const isCommit = GIT_COMMIT_RE.test(command)
  const isPush = GIT_PUSH_RE.test(command)
  if (!isCommit && !isPush) return

  const home = homedir()
  const tasksDir = join(home, ".claude", "tasks", input.session_id)
  const tasks = await readSessionTasks(input.session_id, home)

  // Auto-complete matching commit/push tasks
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "cancelled" || task.status === "deleted") {
      continue
    }
    if (!SUBJECT_RE.test(task.subject)) continue

    const subjectLower = task.subject.toLowerCase()
    if (isPush && subjectLower.includes("push")) {
      task.status = "completed"
      await Bun.write(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2))
    } else if (isCommit && subjectLower.includes("commit")) {
      task.status = "completed"
      await Bun.write(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2))
    }
  }

  // After a push: emit additionalContext so the agent creates a CI-watching task.
  // File writes cannot affect Claude's in-memory task list — only this output channel can.
  if (isPush) {
    const taskCreateName = toolNameForCurrentAgent("TaskCreate")
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `git push succeeded. Use ${taskCreateName} to create a "Wait for CI and verify pass" task, then mark it in_progress and monitor CI before stopping.`,
        },
      })
    )
  }
}

main()
