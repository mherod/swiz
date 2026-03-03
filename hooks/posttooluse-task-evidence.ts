#!/usr/bin/env bun
/**
 * PostToolUse hook: Write completionEvidence to task JSON files
 *
 * Intercepts task-update tools across all supported agents and persists
 * `completionEvidence` plus `completionTimestamp` into the task JSON.
 *
 * Supported tool names (all known task-update aliases):
 *   - TaskUpdate   (Claude Code)
 *   - TodoWrite    (Cursor — shared create/update tool)
 *   - write_todos  (Gemini — shared create/update tool)
 *   - update_plan  (Codex — shared create/update tool)
 *
 * Evidence is extracted from multiple payload locations:
 *   1. metadata.evidence           (primary — explicit evidence string)
 *   2. metadata.completionEvidence (alternative key name)
 *   3. tool_input.evidence         (top-level shorthand)
 *   4. tool_input.completionEvidence (top-level alternative)
 *
 * Task ID is resolved from multiple field names:
 *   taskId, task_id, id  (string or number)
 *
 * Writes are idempotent — identical evidence is not re-written.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ToolHookInput } from "./hook-utils.ts"

/**
 * All tool names that represent a task update operation across agents.
 * Cursor/Gemini/Codex use a single tool for both create and update,
 * so we accept those here — evidence is only written when present.
 */
const TASK_UPDATE_TOOLS = new Set(["TaskUpdate", "TodoWrite", "write_todos", "update_plan"])

interface ExtendedToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    task_id?: string | number
    id?: string | number
    status?: string
    metadata?: Record<string, unknown>
    evidence?: string
    completionEvidence?: string
    [key: string]: unknown
  }
}

const EVIDENCE_KEYS = ["evidence", "completionEvidence"] as const

/** Extract evidence string from multiple payload locations. */
function extractEvidence(input: ExtendedToolInput): string | null {
  const ti = input.tool_input
  if (!ti) return null

  // Check metadata first (structured payload)
  if (ti.metadata) {
    for (const key of EVIDENCE_KEYS) {
      const val = ti.metadata[key]
      if (typeof val === "string" && val.trim()) return val.trim()
    }
  }

  // Check top-level tool_input fields (flat payload)
  for (const key of EVIDENCE_KEYS) {
    const val = ti[key]
    if (typeof val === "string" && val.trim()) return val.trim()
  }

  return null
}

/** Resolve task ID from multiple field names. */
function resolveTaskId(input: ExtendedToolInput): string {
  const ti = input.tool_input
  if (!ti) return ""
  const raw = ti.taskId ?? ti.task_id ?? ti.id ?? ""
  return String(raw)
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  if (!input.session_id) return

  const toolName = input.tool_name ?? ""
  if (!TASK_UPDATE_TOOLS.has(toolName)) return

  const taskId = resolveTaskId(input)
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
