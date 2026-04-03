#!/usr/bin/env bun

/**
 * PostToolUse hook: Inject task count context after TaskCreate/TaskUpdate.
 *
 * Reads the session's task state (via cache when available) and emits an
 * additionalContext message with incomplete/pending/in_progress counts.
 * Warns urgently when pending tasks drop to 1 or 0, since the governance
 * system requires at least 1 pending task at all times.
 */

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import {
  getSessionTasksDir,
  isIncompleteTaskStatus,
  readSessionTasksFresh,
} from "../src/tasks/task-recovery.ts"
import { buildContextHookOutput } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

function buildCountSummary(counts: {
  total: number
  incomplete: number
  pending: number
  inProgress: number
}): string {
  const parts: string[] = [
    `Tasks: ${counts.total} total, ${counts.incomplete} incomplete (${counts.inProgress} in_progress, ${counts.pending} pending).`,
  ]

  if (counts.pending === 0) {
    parts.push(
      "URGENT: Zero pending tasks. Task governance requires ≥1 pending task at all times. Use TaskCreate immediately to plan your next step before continuing any implementation work."
    )
  } else if (counts.pending === 1 && counts.incomplete <= 2) {
    parts.push(
      "Proactive task planning needed: only 1 pending task remains. Create at least 1 more pending task to maintain the planning buffer before completing current work."
    )
  }

  if (counts.inProgress === 0 && counts.incomplete > 0) {
    parts.push(
      "No in_progress task. Transition a pending task to in_progress before starting implementation."
    )
  }

  return parts.join(" ")
}

export async function evaluatePosttooluseTaskCountContext(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const sessionId = resolveSafeSessionId(parsed.session_id)
  if (!sessionId) return {}

  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return {}

  const tasks = await readSessionTasksFresh(sessionId)
  if (tasks.length === 0) return {}

  let pending = 0
  let inProgress = 0
  let incomplete = 0
  for (const t of tasks) {
    if (t.status === "pending") {
      pending++
      incomplete++
    } else if (t.status === "in_progress") {
      inProgress++
      incomplete++
    } else if (isIncompleteTaskStatus(t.status)) {
      incomplete++
    }
  }

  const summary = buildCountSummary({
    total: tasks.length,
    incomplete,
    pending,
    inProgress,
  })

  return buildContextHookOutput("PostToolUse", summary)
}

const posttooluseTaskCountContext: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-count-context",
  event: "postToolUse",
  matcher: "TaskUpdate|TaskCreate|TodoWrite",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskCountContext(input)
  },
}

export default posttooluseTaskCountContext

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskCountContext)
}
