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
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { applyTaskListEvent } from "../src/tasks/task-event-state.ts"
import {
  getSessionTaskPath,
  getSessionTasksDir,
  type SessionTask,
} from "../src/tasks/task-recovery.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import { buildContextHookOutput, resolveSafeSessionId } from "../src/utils/hook-utils.ts"
import type { PostToolHookInput } from "./schemas.ts"

// ─── Types ───────────────────────────────────────────────────────────────────

interface NormalizedTask {
  id: string
  subject: string
  status: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNormalizedTask(t: Record<string, any>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = typeof t.status === "string" ? t.status : "pending"
  if (!id || !subject) return null
  return { id, subject, status }
}

function parseRawTasks(raw: PostToolHookInput["tool_response"]): unknown[] | null {
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
  const items = (parsed as Record<string, any>).tasks
  return Array.isArray(items) ? items : null
}

function parseToolResponse(raw: PostToolHookInput["tool_response"]): NormalizedTask[] {
  const items = parseRawTasks(raw)
  if (!items) return []
  const result: NormalizedTask[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const normalized = parseNormalizedTask(item as Record<string, any>)
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

interface ResolvedListSyncInput {
  sessionId: string
  tasks: NormalizedTask[]
  tasksDir: string
  cwd: string
}

async function resolveListSyncInput(
  input: PostToolHookInput
): Promise<ResolvedListSyncInput | null> {
  if (input.tool_name !== "TaskList") return null
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null
  const tasks = parseToolResponse(input.tool_response)
  if (tasks.length === 0) return null
  const tasksDir = getSessionTasksDir(sessionId, homedir())
  if (!tasksDir) return null
  try {
    await mkdir(tasksDir, { recursive: true })
  } catch {
    return null
  }
  return { sessionId, tasks, tasksDir, cwd: input.cwd ?? process.cwd() }
}

function formatSyncSummary(
  counts: { created: number; updated: number; skipped: number },
  total: number
): string | null {
  if (counts.created === 0 && counts.updated === 0) return null
  const parts: string[] = []
  if (counts.created > 0) parts.push(`${counts.created} created`)
  if (counts.updated > 0) parts.push(`${counts.updated} updated`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  return `TaskList sync: ${parts.join(", ")} (${total} task(s) in response).`
}

export async function evaluatePosttooluseTaskListSync(input: unknown): Promise<SwizHookOutput> {
  const hookInput = input as PostToolHookInput
  const resolved = await resolveListSyncInput(hookInput)
  if (!resolved) return {}

  // Update in-memory event state with the full task list from the response.
  // Downstream hooks in the same dispatch see this immediately without disk reads.
  applyTaskListEvent(
    resolved.sessionId,
    resolved.tasks.map((t) => ({ id: t.id, status: t.status, subject: t.subject }))
  )

  const counts = await reconcileTasks(resolved.tasks, homedir(), resolved.sessionId)
  const summary = formatSyncSummary(counts, resolved.tasks.length)
  if (!summary) return {}

  return buildContextHookOutput("PostToolUse", summary)
}

const posttooluseTaskListSync: SwizHook<PostToolHookInput> = {
  name: "posttooluse-task-list-sync",
  event: "postToolUse",
  matcher: "TaskList",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskListSync(input)
  },
}

export default posttooluseTaskListSync

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskListSync as SwizHook<Record<string, any>>)
}
