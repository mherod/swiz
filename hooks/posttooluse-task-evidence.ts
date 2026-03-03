#!/usr/bin/env bun
/**
 * PostToolUse hook: Write completionEvidence to task JSON files
 *
 * Intercepts task-update tools across all supported agents and persists
 * `completionEvidence` plus `completionTimestamp` into the task JSON.
 *
 * All normalization rules are loaded from `task-evidence-config.json`
 * at startup, with built-in defaults as fallback. To support a new
 * agent tool name, evidence key, or task ID field, edit the config
 * file — no code changes required.
 *
 * Writes are idempotent — identical evidence is not re-written.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ToolHookInput } from "./hook-utils.ts"

// ─── Built-in defaults (used when config is missing or malformed) ───────────

const DEFAULT_TOOL_NAMES = ["TaskUpdate", "TodoWrite", "write_todos", "update_plan"]
const DEFAULT_EVIDENCE_KEYS = ["evidence", "completionEvidence"]
const DEFAULT_TASK_ID_FIELDS = ["taskId", "task_id", "id"]

// ─── Config loading ─────────────────────────────────────────────────────────

interface EvidenceConfig {
  toolNames: string[]
  evidenceKeys: string[]
  taskIdFields: string[]
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((v) => typeof v === "string")
}

async function loadConfig(): Promise<EvidenceConfig> {
  const defaults: EvidenceConfig = {
    toolNames: DEFAULT_TOOL_NAMES,
    evidenceKeys: DEFAULT_EVIDENCE_KEYS,
    taskIdFields: DEFAULT_TASK_ID_FIELDS,
  }

  try {
    const configPath =
      process.env.TASK_EVIDENCE_CONFIG ?? join(dirname(Bun.main), "task-evidence-config.json")
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    return {
      toolNames: isStringArray(parsed.toolNames) ? parsed.toolNames : defaults.toolNames,
      evidenceKeys: isStringArray(parsed.evidenceKeys)
        ? parsed.evidenceKeys
        : defaults.evidenceKeys,
      taskIdFields: isStringArray(parsed.taskIdFields)
        ? parsed.taskIdFields
        : defaults.taskIdFields,
    }
  } catch {
    return defaults
  }
}

// ─── Payload normalization ──────────────────────────────────────────────────

interface ExtendedToolInput extends ToolHookInput {
  tool_input?: Record<string, unknown> & {
    metadata?: Record<string, unknown>
  }
}

function extractEvidence(ti: Record<string, unknown>, keys: string[]): string | null {
  // Check metadata first (structured payload)
  const metadata = ti.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const md = metadata as Record<string, unknown>
    for (const key of keys) {
      const val = md[key]
      if (typeof val === "string" && val.trim()) return val.trim()
    }
  }

  // Check top-level tool_input fields (flat payload)
  for (const key of keys) {
    const val = ti[key]
    if (typeof val === "string" && val.trim()) return val.trim()
  }

  return null
}

function resolveTaskId(ti: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const val = ti[field]
    if (val !== undefined && val !== null && val !== "") return String(val)
  }
  return ""
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  if (!input.session_id) return

  const config = await loadConfig()

  const toolName = input.tool_name ?? ""
  const toolSet = new Set(config.toolNames)
  if (!toolSet.has(toolName)) return

  const ti = input.tool_input
  if (!ti) return

  const taskId = resolveTaskId(ti, config.taskIdFields)
  if (!taskId) return

  const evidence = extractEvidence(ti, config.evidenceKeys)
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
