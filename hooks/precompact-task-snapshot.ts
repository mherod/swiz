#!/usr/bin/env bun
// PreCompact hook: Snapshot all current-session task IDs and statuses to disk
// before context compaction rewrites the transcript.
//
// Writes ~/.claude/tasks/<session-id>/compact-snapshot.json with the complete
// task list at the moment compaction triggers. The sessionstart-compact-context
// hook reads this snapshot on resume to verify and recreate any missing task
// files, providing a definitive fallback that does not depend on transcript
// discovery or the agent's in-context memory.

import { join } from "node:path"
import { limitItems, readSessionTasks, type SessionTask } from "./hook-utils.ts"
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
  const incomplete = tasks.filter((t) => t.status === "pending" || t.status === "in_progress")

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

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json().catch(() => null)) as Record<string, unknown> | null
  const input = raw !== null ? sessionHookInputSchema.parse(raw) : null
  const sessionId = input?.session_id ?? ""
  if (!sessionId) return

  const home = process.env.HOME ?? ""
  if (!home) return

  const tasks = await readSessionTasks(sessionId, home)
  if (tasks.length === 0) return

  const snapshotTasks = tasks.map((t) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    ...(t.description ? { description: t.description } : {}),
  }))

  const snapshot: CompactSnapshot = {
    sessionId,
    compactedAt: new Date().toISOString(),
    tasks: snapshotTasks,
    summary: buildCompactSnapshotSummary(snapshotTasks),
  }

  const snapshotPath = join(home, ".claude", "tasks", sessionId, "compact-snapshot.json")
  await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2))
}

if (import.meta.main) main()
