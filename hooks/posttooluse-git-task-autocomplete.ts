#!/usr/bin/env bun
/**
 * PostToolUse hook: Auto-complete Commit/Push tasks after git operations
 *
 * After a successful `git commit` or `git push` Bash call, scans the session's
 * task files and marks any pending/in_progress task whose subject contains
 * "Commit" or "Push" (case-insensitive) as completed.
 *
 * After a push, also creates a pending "Wait for CI" task if one doesn't
 * already exist, so Bash isn't blocked when all commit/push tasks auto-complete.
 */

import { readdir, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { type ToolHookInput, isShellTool } from "./hook-utils.ts"

const GIT_COMMIT_RE = /\bgit\s+commit\b/
const GIT_PUSH_RE = /\bgit\s+push\b/
const SUBJECT_RE = /\b(commit|push)\b/i
const CI_SUBJECT_RE = /\b(ci|wait for ci|github ci)\b/i

interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | "deleted"
  blocks: string[]
  blockedBy: string[]
}

async function readAllTasks(tasksDir: string, files: string[]): Promise<Task[]> {
  const tasks: Task[] = []
  for (const file of files.filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
    try {
      tasks.push(JSON.parse(await Bun.file(join(tasksDir, file)).text()))
    } catch {
      // skip malformed files
    }
  }
  return tasks
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
    if (!isPush) return
    // For push: create the directory so we can write the CI task
    try {
      await mkdir(tasksDir, { recursive: true })
      files = []
    } catch {
      return
    }
  }

  const tasks = await readAllTasks(tasksDir, files)

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

  // After a push: ensure a CI-watching task exists so Bash isn't blocked
  if (isPush) {
    const hasCiTask = tasks.some(
      (t) =>
        t.status !== "completed" &&
        t.status !== "cancelled" &&
        t.status !== "deleted" &&
        CI_SUBJECT_RE.test(t.subject)
    )

    if (!hasCiTask) {
      const maxId = tasks.reduce((max, t) => Math.max(max, parseInt(t.id) || 0), 0)
      const newTask: Task = {
        id: String(maxId + 1),
        subject: "Wait for CI and verify pass",
        description: "CI is running after push. Wait for it to complete and confirm all checks pass.",
        activeForm: "Waiting for CI",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }
      await Bun.write(join(tasksDir, `${newTask.id}.json`), JSON.stringify(newTask, null, 2))
    }
  }
}

main()
