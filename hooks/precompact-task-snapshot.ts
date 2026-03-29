#!/usr/bin/env bun
// PreCompact hook: Snapshot all current-session task IDs and statuses to disk
// before context compaction rewrites the transcript.
//
// Writes ~/.claude/tasks/<session-id>/compact-snapshot.json with the complete
// task list at the moment compaction triggers. The sessionstart-compact-context
// hook reads this snapshot on resume to verify and recreate any missing task
// files, providing a definitive fallback that does not depend on transcript
// discovery or the agent's in-context memory.

import { getHomeDirWithFallback } from "../src/home.ts"
import {
  getSessionCompactSnapshotPath,
  isIncompleteTaskStatus,
  limitItems,
  readSessionTasks,
  type SessionTask,
} from "../src/utils/hook-utils.ts"
import { sessionHookInputSchema } from "./schemas.ts"

export interface CompactSnapshot {
  sessionId: string
  compactedAt: string
  tasks: Pick<SessionTask, "id" | "subject" | "status" | "activeForm" | "description">[]
  summary?: CompactSnapshotSummary
}

export interface CompactSnapshotSummary {
  completedCount: number
  incompleteCount: number
  completedHighlights: string[]
  nextActions: string[]
  openDecisions: string[]
}

type SnapshotTask = Pick<SessionTask, "id" | "subject" | "status" | "activeForm" | "description">

const SUMMARY_ITEM_LIMIT = 3
const SUMMARY_TEXT_MAX_CHARS = 96
const OPEN_DECISION_RE = /\b(decide|decision|choose|choice|confirm|clarify|tbd|open question)\b/i

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncateSummaryText(text: string, maxChars = SUMMARY_TEXT_MAX_CHARS): string {
  const normalized = normalizeSummaryText(text)
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 3) return normalized.slice(0, maxChars)
  return `${normalized.slice(0, maxChars - 3)}...`
}

function uniquePreview(items: string[], limit = SUMMARY_ITEM_LIMIT): string[] {
  const deduped = [...new Set(items.map((item) => truncateSummaryText(item)).filter(Boolean))]
  return limitItems(deduped, limit).visible
}

export function buildCompactSnapshotSummary(
  tasks: Pick<SessionTask, "status" | "subject" | "activeForm" | "description">[]
): CompactSnapshotSummary {
  const completed = tasks.filter((t) => t.status === "completed")
  const incomplete = tasks.filter((t) => isIncompleteTaskStatus(t.status))

  const completedHighlights = uniquePreview(completed.map((t) => t.subject))
  const nextActions = uniquePreview(incomplete.map((t) => t.activeForm || t.subject))
  const openDecisions = uniquePreview(
    tasks
      .filter((t) => OPEN_DECISION_RE.test(`${t.subject} ${t.description ?? ""}`))
      .map((t) => t.subject)
  )

  return {
    completedCount: completed.length,
    incompleteCount: incomplete.length,
    completedHighlights,
    nextActions,
    openDecisions,
  }
}

function toSnapshotTasks(tasks: SessionTask[]): SnapshotTask[] {
  return tasks.map((task) => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    ...(task.description ? { description: task.description } : {}),
  }))
}

function buildSnapshot(sessionId: string, tasks: SnapshotTask[]): CompactSnapshot {
  return {
    sessionId,
    compactedAt: new Date().toISOString(),
    tasks,
    summary: buildCompactSnapshotSummary(tasks),
  }
}

async function main(): Promise<void> {
  const input = sessionHookInputSchema.parse(await Bun.stdin.json())
  const sessionId = input.session_id ?? ""
  if (!sessionId) return

  const home = getHomeDirWithFallback("")
  if (!home) return

  const sessionTasks = await readSessionTasks(sessionId, home)
  if (sessionTasks.length === 0) return
  const snapshotTasks = toSnapshotTasks(sessionTasks)
  const snapshot = buildSnapshot(sessionId, snapshotTasks)

  const snapshotPath = getSessionCompactSnapshotPath(sessionId, home)
  if (!snapshotPath) return
  await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2))
}

if (import.meta.main) await main()
