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

function parseToolResponse(raw: ExtendedToolHookInput["tool_response"]): NormalizedTask[] {
  if (!raw) return []

  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []

  const obj = parsed as Record<string, unknown>
  const items = Array.isArray(obj.tasks) ? obj.tasks : null
  if (!items) return []

  const result: NormalizedTask[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const t = item as Record<string, unknown>
    const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
    const subject = typeof t.subject === "string" ? t.subject : ""
    const status = typeof t.status === "string" ? t.status : "pending"
    if (!id || !subject) continue
    result.push({ id, subject, status })
  }
  return result
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

  let created = 0
  let updated = 0
  let skipped = 0

  for (const task of tasks) {
    const taskPath = getSessionTaskPath(sessionId, task.id, home)
    if (!taskPath) continue

    const file = Bun.file(taskPath)
    const exists = await file.exists()

    if (!exists) {
      const nowIso = new Date().toISOString()
      const nowMs = Date.now()
      // Write new task file
      const taskRecord: SessionTask = {
        id: task.id,
        subject: task.subject,
        status: task.status,
        statusChangedAt: nowIso,
        elapsedMs: 0,
        startedAt: task.status === "in_progress" ? nowMs : null,
        completedAt: task.status === "completed" ? nowMs : null,
        ...(task.status === "completed" ? { completionTimestamp: nowIso } : {}),
      }
      try {
        await Bun.write(taskPath, JSON.stringify(taskRecord, null, 2))
        created++
      } catch {
        // Skip on write failure — non-blocking
      }
      continue
    }

    // Reconcile existing file — only update changed fields
    let existing: SessionTask
    try {
      existing = (await file.json()) as SessionTask
    } catch {
      skipped++
      continue
    }

    const subjectChanged = existing.subject !== task.subject
    const statusChanged = existing.status !== task.status

    if (!subjectChanged && !statusChanged) {
      skipped++
      continue
    }

    const merged: SessionTask = {
      ...existing,
      subject: task.subject,
      status: task.status,
    }

    if (statusChanged) {
      const nowIso = new Date().toISOString()
      const nowMs = Date.now()
      if (existing.status === "in_progress") {
        merged.elapsedMs = getTaskCurrentDurationMs(existing, nowMs)
      }
      merged.statusChangedAt = nowIso
      if (task.status === "in_progress") {
        merged.startedAt = nowMs
      }
      if (task.status === "completed") {
        merged.completedAt = nowMs
        if (!merged.completionTimestamp) merged.completionTimestamp = nowIso
      }
    }

    try {
      await Bun.write(taskPath, JSON.stringify(merged, null, 2))
      updated++
    } catch {
      skipped++
    }
  }

  if (created === 0 && updated === 0) return

  const parts: string[] = []
  if (created > 0) parts.push(`${created} created`)
  if (updated > 0) parts.push(`${updated} updated`)
  if (skipped > 0) parts.push(`${skipped} skipped`)

  emitContext(
    "PostToolUse",
    `TaskList sync: ${parts.join(", ")} (${tasks.length} task(s) in response).`,
    input.cwd
  )
}

if (import.meta.main) main()
