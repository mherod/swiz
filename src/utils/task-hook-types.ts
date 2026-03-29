/**
 * Shared types and builders for task-related hooks.
 *
 * Centralises TaskFile, TaskToolInput (ExtendedToolInput), and task stub
 * construction so pretooluse-task-recovery, posttooluse-task-recovery,
 * and posttooluse-task-evidence share a single definition.
 */

import type { SessionTask, ToolHookInput } from "./hook-utils.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

/** Strict task file shape with all timing fields required — used by builders. */
export type TaskFile = Required<
  Pick<
    SessionTask,
    | "id"
    | "subject"
    | "description"
    | "status"
    | "statusChangedAt"
    | "elapsedMs"
    | "startedAt"
    | "completedAt"
  >
> &
  Pick<SessionTask, "activeForm" | "completionTimestamp"> & {
    blocks: string[]
    blockedBy: string[]
  }

/** ToolHookInput extended with typed task tool_input fields. */
export interface TaskToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    status?: string
    subject?: string
    description?: string
    activeForm?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

const VALID_RECOVERY_STATUSES = new Set(["pending", "in_progress", "completed"])

/** Build a recovery stub task for a missing task file. */
export function buildRecoveryStub(
  taskId: string,
  opts: {
    subject?: string
    description?: string
    activeForm?: string
    status?: string
    source: string
  }
): TaskFile {
  const status = VALID_RECOVERY_STATUSES.has(opts.status ?? "") ? opts.status! : "in_progress"
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()

  return {
    id: taskId,
    subject: opts.subject ?? `Recovered task #${taskId} (lost during compaction)`,
    description:
      opts.description ??
      `This task was automatically recovered by ${opts.source} ` +
        `after task #${taskId} was not found on disk. ` +
        `Status '${status}' has been applied.`,
    activeForm: opts.activeForm,
    status,
    blocks: [],
    blockedBy: [],
    statusChangedAt: nowIso,
    elapsedMs: 0,
    startedAt: nowMs,
    completedAt: status === "completed" ? nowMs : null,
    completionTimestamp: status === "completed" ? nowIso : undefined,
  }
}
