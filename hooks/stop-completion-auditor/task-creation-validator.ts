/**
 * Task Creation Enforcement Validator
 *
 * Enforces TOOL_CALL_THRESHOLD: minimum tool call count before tasks can complete.
 * Returns blocking result if threshold not met and agent has task tools.
 */

import { agentHasTaskTools } from "../../src/agent-paths.ts"
import { formatActionPlan, mergeActionPlanIntoTasks } from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem, CompletionAuditContext, ValidationResult } from "./types.ts"

const TOOL_CALL_THRESHOLD = 10

export async function validateTaskCreation(ctx: CompletionAuditContext): Promise<ValidationResult> {
  // Skip validation if gate is disabled
  if (!ctx.gates.taskCreation) return { kind: "ok" }

  // Skip if task tools were already used OR tasks exist on disk (authoritative
  // after compaction truncates the transcript, losing TaskCreate evidence).
  if (ctx.taskToolUsed || ctx.allTasks.length > 0) return { kind: "ok" }

  // Skip if agent doesn't have task tools
  if (!agentHasTaskTools()) return { kind: "ok" }

  // Check if tool call count meets threshold
  if (ctx.toolCallCount < TOOL_CALL_THRESHOLD) {
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

    // Merge into session tasks before blocking
    await mergeActionPlanIntoTasks(
      planSteps.map((s) => s.description),
      ctx.sessionId,
      ctx.cwd
    )

    return {
      kind: "task-creation",
      reason:
        `No tasks were created this session (${ctx.toolCallCount} tool calls made).\n\n` +
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
