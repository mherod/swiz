/**
 * Audit Log Fallback Validator
 *
 * Falls back to audit log validation when no live task files exist.
 * Parses .audit-log.jsonl and validates task status transitions.
 * Returns null if stop is allowed, blocking result otherwise.
 */

import { join } from "node:path"
import { agentHasTaskTools } from "../../src/agent-paths.ts"
import { isIncompleteTaskStatus } from "../../src/tasks/task-recovery.ts"
import { formatActionPlan, mergeActionPlanIntoTasks } from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem, CompletionAuditContext, ValidationResult } from "./types.ts"

interface AuditEntry {
  action: string
  taskId: string
  newStatus?: string
  timestamp?: string
}

export async function validateAuditLog(ctx: CompletionAuditContext): Promise<ValidationResult> {
  // Skip validation if gate is disabled
  if (!ctx.gates.auditLog) return { kind: "ok" }

  // Skip if we have live task files
  if (ctx.allTasks.length > 0) return { kind: "ok" }

  // Skip if task tools were already used
  if (ctx.taskToolUsed) return { kind: "ok" }

  // Skip if agent doesn't have task tools
  if (!agentHasTaskTools()) return { kind: "ok" }

  // Try to read and parse audit log
  const auditLog = join(ctx.tasksDir, ".audit-log.jsonl")
  try {
    const auditText = await Bun.file(auditLog).text()
    const entries: AuditEntry[] = auditText
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean) as AuditEntry[]

    const created = entries.filter((e) => e.action === "create").length
    const latestStatus = new Map<string, string>()
    for (const e of entries) {
      if (e.action === "status_change" && e.newStatus) {
        latestStatus.set(e.taskId, e.newStatus)
      }
    }
    const incomplete = Array.from(latestStatus.values()).filter((s) =>
      isIncompleteTaskStatus(s)
    ).length

    // If tasks were created and none are incomplete, allow stop
    if (created > 0 && incomplete === 0) return { kind: "ok" }
  } catch {
    // Audit log doesn't exist or can't be parsed; check tool call threshold
  }

  // Check tool call threshold
  if (ctx.toolCallCount >= TOOL_CALL_THRESHOLD) {
    const planSteps: ActionPlanItem[] = [
      {
        description: "Use TaskCreate to create one task for each significant piece of work",
        priority: 1,
      },
      {
        description: "Use TaskUpdate to mark each task completed after recording the work",
        priority: 2,
      },
    ]

    await mergeActionPlanIntoTasks(
      planSteps.map((s) => s.description),
      ctx.sessionId,
      ctx.cwd
    )

    return {
      kind: "audit-log",
      reason:
        `No completed tasks on record (${ctx.toolCallCount} tool calls made).\n\n` +
        formatActionPlan(
          planSteps.map((s) => s.description),
          {
            translateToolNames: true,
            observedToolNames: ctx.observedToolNames,
          }
        ),
      planSteps,
    }
  }

  return { kind: "ok" }
}

const TOOL_CALL_THRESHOLD = 10
