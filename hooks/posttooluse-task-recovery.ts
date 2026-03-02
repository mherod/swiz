#!/usr/bin/env bun
/**
 * PostToolUse hook: Detect missing tasks and instruct recovery.
 *
 * After TaskUpdate or TaskGet, checks whether the referenced task ID
 * exists on disk. If it doesn't (e.g. lost during context compaction),
 * emits additionalContext instructing the agent to recreate a replacement
 * task and validate the create→in_progress→completed lifecycle.
 */

import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isTaskTool, type ToolHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  if (!input.session_id) return

  const toolName = input.tool_name ?? ""
  if (!isTaskTool(toolName)) return

  // Only act on tools that reference an existing task by ID
  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  // TaskCreate doesn't reference existing IDs — skip it
  if (toolName === "TaskCreate") return

  const tasksDir = join(homedir(), ".claude", "tasks", input.session_id)
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    // No tasks directory at all — task is definitely missing
    files = []
  }

  const taskExists = files.some((f) => f === `${taskId}.json`)
  if (taskExists) return

  // Task file not found — emit recovery instructions
  const context = [
    `Task #${taskId} not found on disk — likely lost during context compaction.`,
    "Recovery steps:",
    `1. Use TaskCreate to recreate a replacement task describing what task #${taskId} was tracking.`,
    "2. Mark the new task in_progress with TaskUpdate.",
    "3. If the work is already done, mark it completed immediately.",
    "4. Use TaskGet on the new task to confirm the status was recorded.",
    "Do NOT ignore this — untracked work causes stop hook failures.",
  ].join(" ")

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    })
  )
}

main()
