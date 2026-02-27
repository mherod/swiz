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

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { type ToolHookInput, isShellTool } from "./hook-utils.ts"

const GIT_COMMIT_RE = /(?:^|;|&&|\|\|)\s*git\s+commit\b/
const GIT_PUSH_RE = /(?:^|;|&&|\|\|)\s*git\s+push\b/
const SUBJECT_RE = /\b(commit|push)\b/i

interface Task {
  id: string
  subject: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | "deleted"
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  if (!input.session_id) return
  if (!input.tool_name || !isShellTool(input.tool_name)) return

  const command = String(input.tool_input?.command ?? "")
  const isCommit = GIT_COMMIT_RE.test(command)
  const isPush = GIT_PUSH_RE.test(command)
  if (!isCommit && !isPush) return

  const tasksDir = join(homedir(), ".claude", "tasks", input.session_id)
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    // No tasks directory — nothing to auto-complete; still emit CI reminder on push
    files = []
  }

  const taskFiles = files.filter((f) => f.endsWith(".json") && !f.startsWith("."))

  // Auto-complete matching commit/push tasks
  for (const file of taskFiles) {
    const path = join(tasksDir, file)
    let task: Task
    try {
      task = JSON.parse(await Bun.file(path).text())
    } catch {
      continue
    }

    if (task.status === "completed" || task.status === "cancelled" || task.status === "deleted") {
      continue
    }
    if (!SUBJECT_RE.test(task.subject)) continue

    const subjectLower = task.subject.toLowerCase()
    if (isPush && subjectLower.includes("push")) {
      task.status = "completed"
      await Bun.write(path, JSON.stringify(task, null, 2))
    } else if (isCommit && subjectLower.includes("commit")) {
      task.status = "completed"
      await Bun.write(path, JSON.stringify(task, null, 2))
    }
  }

  // After a push: emit additionalContext so the agent creates a CI-watching task.
  // File writes cannot affect Claude's in-memory task list — only this output channel can.
  if (isPush) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "git push succeeded. Use TaskCreate to create a task: subject='Wait for CI and verify pass', then mark it in_progress and monitor CI before stopping.",
        },
      })
    )
  }
}

main()
