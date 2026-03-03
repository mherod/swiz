#!/usr/bin/env bun
/**
 * PostToolUse hook: Write completionEvidence to task JSON files
 *
 * Intercepts TaskUpdate (and cross-agent equivalents like update_plan)
 * when evidence is provided, and persists `completionEvidence` plus
 * `completionTimestamp` into the task JSON on disk.
 *
 * Evidence is extracted from multiple payload locations:
 *   1. metadata.evidence (primary — explicit evidence string)
 *   2. metadata.completionEvidence (alternative key name)
 *
 * Writes are idempotent — identical evidence is not re-written.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ToolHookInput } from "./hook-utils.ts"

/** Tool names that represent a task update operation across agents. */
const TASK_UPDATE_TOOLS = new Set(["TaskUpdate", "update_plan"])

interface ExtendedToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    status?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}

/** Extract evidence string from multiple payload locations. */
function extractEvidence(input: ExtendedToolInput): string | null {
  const metadata = input.tool_input?.metadata
  if (!metadata) return null

  for (const key of ["evidence", "completionEvidence"]) {
    const val = metadata[key]
    if (typeof val === "string" && val.trim()) return val.trim()
  }
  return null
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  if (!input.session_id) return

  const toolName = input.tool_name ?? ""
  if (!TASK_UPDATE_TOOLS.has(toolName)) return

  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  const evidence = extractEvidence(input)
  if (!evidence) return

  const tasksDir = join(homedir(), ".claude", "tasks", input.session_id)
  const taskPath = join(tasksDir, `${taskId}.json`)

  try {
    const raw = await readFile(taskPath, "utf-8")
    const task = JSON.parse(raw)

    // Idempotent — skip if evidence is already identical
    if (task.completionEvidence === evidence) return

    task.completionEvidence = evidence
    task.completionTimestamp = new Date().toISOString()
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
  } catch {
    // Task file doesn't exist or is unreadable — skip silently
  }
}

main()
