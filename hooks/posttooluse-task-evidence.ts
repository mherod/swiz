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

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { getSessionTaskPath, resolveSafeSessionId, type ToolHookInput } from "./hook-utils.ts"

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

type ConfigWarning = { field: string; message: string }

function warn(msg: string): void {
  process.stderr.write(`[task-evidence-config] ${msg}\n`)
}

/**
 * Validate a single config field. Returns the cleaned array and any warnings.
 * Checks: must be array, elements must be strings, no empty strings, no duplicates, non-empty result.
 */
function validateStringArray(
  field: string,
  val: unknown,
  fallback: string[]
): { value: string[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = []

  if (val === undefined) {
    return { value: fallback, warnings }
  }

  if (!Array.isArray(val)) {
    warnings.push({ field, message: `expected array, got ${typeof val} — using defaults` })
    return { value: fallback, warnings }
  }

  const nonStrings = val.filter((v) => typeof v !== "string")
  if (nonStrings.length > 0) {
    warnings.push({
      field,
      message: `${nonStrings.length} non-string element(s) removed: ${JSON.stringify(nonStrings)}`,
    })
  }

  const strings = val.filter((v): v is string => typeof v === "string")

  const empties = strings.filter((s) => !s.trim())
  if (empties.length > 0) {
    warnings.push({ field, message: `${empties.length} empty string(s) removed` })
  }
  const cleaned = strings.filter((s) => s.trim())

  const seen = new Set<string>()
  const dupes: string[] = []
  const deduped: string[] = []
  for (const s of cleaned) {
    if (seen.has(s)) {
      dupes.push(s)
    } else {
      seen.add(s)
      deduped.push(s)
    }
  }
  if (dupes.length > 0) {
    warnings.push({ field, message: `duplicate(s) removed: ${JSON.stringify(dupes)}` })
  }

  if (deduped.length === 0) {
    warnings.push({ field, message: "resolved to empty array — using defaults" })
    return { value: fallback, warnings }
  }

  return { value: deduped, warnings }
}

async function loadConfig(): Promise<EvidenceConfig> {
  const defaults: EvidenceConfig = {
    toolNames: DEFAULT_TOOL_NAMES,
    evidenceKeys: DEFAULT_EVIDENCE_KEYS,
    taskIdFields: DEFAULT_TASK_ID_FIELDS,
  }

  const configPath =
    process.env.TASK_EVIDENCE_CONFIG ?? join(dirname(Bun.main), "task-evidence-config.json")

  let parsed: Record<string, unknown>
  try {
    const raw = await Bun.file(configPath).text()
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Config missing or unreadable — silent fallback to defaults
    return defaults
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn("config root must be an object — using all defaults")
    return defaults
  }

  // Check for unrecognised top-level keys (excluding $ keys like $schema, $comment)
  const knownKeys = new Set(["toolNames", "evidenceKeys", "taskIdFields"])
  const unknownKeys = Object.keys(parsed).filter((k) => !k.startsWith("$") && !knownKeys.has(k))
  if (unknownKeys.length > 0) {
    warn(`unknown config key(s) ignored: ${JSON.stringify(unknownKeys)}`)
  }

  const allWarnings: ConfigWarning[] = []

  const tn = validateStringArray("toolNames", parsed.toolNames, defaults.toolNames)
  const ek = validateStringArray("evidenceKeys", parsed.evidenceKeys, defaults.evidenceKeys)
  const tf = validateStringArray("taskIdFields", parsed.taskIdFields, defaults.taskIdFields)

  allWarnings.push(...tn.warnings, ...ek.warnings, ...tf.warnings)

  for (const w of allWarnings) {
    warn(`${w.field}: ${w.message}`)
  }

  return {
    toolNames: tn.value,
    evidenceKeys: ek.value,
    taskIdFields: tf.value,
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
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return

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

  const taskPath = getSessionTaskPath(sessionId, taskId, homedir())
  if (!taskPath) return

  try {
    const raw = await Bun.file(taskPath).text()
    const task = JSON.parse(raw)

    // Idempotent — skip if evidence is already identical
    if (task.completionEvidence === evidence) return

    const nowIso = new Date().toISOString()
    task.completionEvidence = evidence
    task.completionTimestamp = nowIso
    if (task.completedAt === undefined || task.completedAt === null) {
      task.completedAt = Date.now()
    }
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
  } catch {
    // Task file doesn't exist or is unreadable — skip silently
  }
}

if (import.meta.main) void main()
