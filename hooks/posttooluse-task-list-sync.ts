#!/usr/bin/env bun
/**
 * PostToolUse hook: Synchronize TaskList output to the file-based task store.
 *
 * After TaskList runs, this hook reads the tool_response (the internal task
 * model) and reconciles it into ~/.claude/tasks/<session>/. Writes are
 * idempotent — only tasks whose subject or status have changed are updated.
 *
 * New task IDs seen in the response that have no file on disk are written
 * immediately so the stop hook's file-based completion auditor stays in sync.
 *
 * Emits a concise additionalContext summary (synced/created/skipped counts).
 *
 * Safe no-ops when session_id, tool_response, or the task directory is absent.
 */

import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import {
  emitContext,
  getSessionTaskPath,
  getSessionTasksDir,
  resolveSafeSessionId,
  type SessionTask,
  type ToolHookInput,
} from "./hook-utils.ts"

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskListResponse {
  tasks?: unknown[]
  [key: string]: unknown
}

interface ExtendedToolHookInput extends ToolHookInput {
  tool_response?: TaskListResponse | string | null
}

interface NormalizedTask {
  id: string
  subject: string
  status: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNormalizedTask(t: Record<string, unknown>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = typeof t.status === "string" ? t.status : "pending"
  if (!id || !subject) return null
  return { id, subject, status }
}

function parseRawTasks(raw: ExtendedToolHookInput["tool_response"]): unknown[] | null {
  if (!raw) return null
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const items = (parsed as Record<string, unknown>).tasks
  return Array.isArray(items) ? items : null
}

function parseToolResponse(raw: ExtendedToolHookInput["tool_response"]): NormalizedTask[] {
  const items = parseRawTasks(raw)
  if (!items) return []
  const result: NormalizedTask[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const normalized = parseNormalizedTask(item as Record<string, unknown>)
    if (normalized) result.push(normalized)
  }
  return result
}

function buildNewTaskRecord(task: NormalizedTask, nowIso: string, nowMs: number): SessionTask {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    statusChangedAt: nowIso,
    elapsedMs: 0,
    startedAt: task.status === "in_progress" ? nowMs : null,
    completedAt: task.status === "completed" ? nowMs : null,
    ...(task.status === "completed" ? { completionTimestamp: nowIso } : {}),
  }
}

function updateExistingTask(existing: SessionTask, task: NormalizedTask): SessionTask {
  const merged: SessionTask = { ...existing, subject: task.subject, status: task.status }
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  if (existing.status === "in_progress") {
    merged.elapsedMs = getTaskCurrentDurationMs(existing, nowMs)
  }
  merged.statusChangedAt = nowIso
  if (task.status === "in_progress") merged.startedAt = nowMs
  if (task.status === "completed") {
    merged.completedAt = nowMs
    if (!merged.completionTimestamp) merged.completionTimestamp = nowIso
  }
  return merged
}

interface SyncCounts {
  created: number
  updated: number
  skipped: number
}

async function reconcileTasks(
  tasks: NormalizedTask[],
  home: string,
  sessionId: string
): Promise<SyncCounts> {
  const counts: SyncCounts = { created: 0, updated: 0, skipped: 0 }

  for (const task of tasks) {
    const taskPath = getSessionTaskPath(sessionId, task.id, home)
    if (!taskPath) continue

    const file = Bun.file(taskPath)
    const exists = await file.exists()

    if (!exists) {
      const taskRecord = buildNewTaskRecord(task, new Date().toISOString(), Date.now())
      try {
        await Bun.write(taskPath, JSON.stringify(taskRecord, null, 2))
        counts.created++
      } catch {}
      continue
    }

    let existing: SessionTask
    try {
      existing = (await file.json()) as SessionTask
    } catch {
      counts.skipped++
      continue
    }

    if (existing.subject === task.subject && existing.status === task.status) {
      counts.skipped++
      continue
    }

    const merged = updateExistingTask(existing, task)
    try {
      await Bun.write(taskPath, JSON.stringify(merged, null, 2))
      counts.updated++
    } catch {
      counts.skipped++
    }
  }

  return counts
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolHookInput
  if (input.tool_name !== "TaskList") return
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return

  const tasks = parseToolResponse(input.tool_response)
  if (tasks.length === 0) return

  const home = homedir()
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return

  try {
    await mkdir(tasksDir, { recursive: true })
  } catch {
    return
  }

  const { created, updated, skipped } = await reconcileTasks(tasks, home, sessionId)

  if (created === 0 && updated === 0) return

  const parts: string[] = []
  if (created > 0) parts.push(`${created} created`)
  if (updated > 0) parts.push(`${updated} updated`)
  if (skipped > 0) parts.push(`${skipped} skipped`)

  await emitContext(
    "PostToolUse",
    `TaskList sync: ${parts.join(", ")} (${tasks.length} task(s) in response).`,
    input.cwd
  )
}

if (import.meta.main) void main()
