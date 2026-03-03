#!/usr/bin/env bun
/**
 * PostToolUse hook: Write completionEvidence to task JSON files
 *
 * When TaskUpdate is called with `metadata.evidence`, reads the task file
 * from disk and writes `completionEvidence` (and `completionTimestamp`)
 * into it. This bridges the gap between Claude Code's built-in TaskUpdate
 * tool (which doesn't natively support completionEvidence) and the
 * stop-completion-auditor hook (which checks task files for CI evidence).
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isTaskTool, type ToolHookInput } from "./hook-utils.ts"

interface ExtendedToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    status?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  if (!input.session_id) return

  const toolName = input.tool_name ?? ""
  if (toolName !== "TaskUpdate" && !isTaskTool(toolName)) return
  // Only act on TaskUpdate, not TaskCreate/TaskGet/TaskList
  if (toolName !== "TaskUpdate") return

  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  const evidence = input.tool_input?.metadata?.evidence
  if (typeof evidence !== "string" || !evidence.trim()) return

  const tasksDir = join(homedir(), ".claude", "tasks", input.session_id)
  const taskPath = join(tasksDir, `${taskId}.json`)

  try {
    const raw = await readFile(taskPath, "utf-8")
    const task = JSON.parse(raw)
    task.completionEvidence = evidence.trim()
    task.completionTimestamp = new Date().toISOString()
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
  } catch {
    // Task file doesn't exist or is unreadable — skip silently
  }
}

main()
