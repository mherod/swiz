#!/usr/bin/env bun
/**
 * PostToolUse hook: Auto-complete Commit/Push tasks after git operations
 *
 * After a successful `git commit` or `git push` Bash call, scans the session's
 * task files and marks any pending/in_progress task whose subject contains
 * "Commit" or "Push" (case-insensitive) as completed.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { type ToolHookInput, isShellTool } from "./hook-utils.ts"

const GIT_COMMIT_RE = /\bgit\s+commit\b/
const GIT_PUSH_RE = /\bgit\s+push\b/
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
    return // no tasks directory — nothing to do
  }

  const taskFiles = files.filter((f) => f.endsWith(".json") && !f.startsWith("."))

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

    // Only auto-complete if the operation matches the task keyword
    const subjectLower = task.subject.toLowerCase()
    if (isPush && subjectLower.includes("push")) {
      task.status = "completed"
    } else if (isCommit && subjectLower.includes("commit")) {
      task.status = "completed"
    } else {
      continue
    }

    await Bun.write(path, JSON.stringify(task, null, 2))
  }
}

main()
