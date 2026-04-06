/**
 * Main Orchestration Module
 *
 * Orchestrates all four validators in parallel and unifies results.
 * Entry point for the modular stop-completion-auditor hook.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"
import { buildActionPlan, formatBlockReason } from "./action-plan.ts"
import { validateAuditLog } from "./audit-log-validator.ts"
import { validateCiEvidence } from "./ci-evidence-validator.ts"
import { resolveCompletionAuditContext } from "./context.ts"
import { validateTaskCreation } from "./task-creation-validator.ts"
import {
  hasIncompleteTask,
  requireTaskListSync,
  resolveToolCallStats,
} from "./task-reconciliation.ts"
import type { CompletionAuditContext, ValidationResult } from "./types.ts"

/**
 * Main evaluation function: orchestrate all validators in sequence.
 * Returns blocking output or empty object when stop may proceed.
 */
export async function evaluateStopCompletionAuditor(input: StopHookInput): Promise<SwizHookOutput> {
  const raw = input as Record<string, any>

  // Resolve all prerequisites and load context
  const baseCtx = await resolveCompletionAuditContext(input, raw)
  if (!baseCtx) return {} // Fail-open: prerequisites not met

  // Enrich context with tool call statistics
  const stats = await resolveToolCallStats(raw, baseCtx.transcript)
  const ctx: CompletionAuditContext = {
    ...baseCtx,
    toolCallCount: stats.total,
    taskToolUsed: stats.taskToolUsed,
    observedToolNames: stats.toolNames,
  }

  // Check: Require TaskList sync before stop if tasks exist
  const syncCheck = requireTaskListSync(ctx)
  if (syncCheck) {
    return blockStopObj(syncCheck.reason ?? "")
  }

  // Check: If incomplete tasks exist, let stop-incomplete-tasks handle it
  // This hook only handles completed task validation and CI evidence.
  if (hasIncompleteTask(ctx)) {
    return {}
  }

  // Run all validators in parallel
  const [taskCreationResult, auditLogResult, ciEvidenceResult] = await Promise.all([
    validateTaskCreation(ctx),
    validateAuditLog(ctx),
    validateCiEvidence(ctx),
  ])

  // Collect all results
  const results: ValidationResult[] = [taskCreationResult, auditLogResult, ciEvidenceResult]

  // Build unified action plan from all failures
  const plan = buildActionPlan(results)

  if (!plan) {
    // All validators passed
    return {}
  }

  // Format and return blocking result
  const reason = formatBlockReason(plan, ctx.observedToolNames)
  return blockStopObj(reason)
}
