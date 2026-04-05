/**
 * Type definitions for the modular stop-completion-auditor validation pipeline.
 *
 * Separates four validation concerns:
 * 1. Task creation enforcement (TOOL_CALL_THRESHOLD)
 * 2. Audit log validation (fallback when no task files)
 * 3. CI evidence requirement (after git push)
 * 4. Task reconciliation (state consistency)
 */

import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import type { TranscriptSummary } from "../../src/utils/hook-utils.ts"

/** Control which validation gates are active. */
export interface CompletionValidationGate {
  taskCreation: boolean
  auditLog: boolean
  ciEvidence: boolean
}

/** Single action plan step from a validator. */
export interface ActionPlanItem {
  description: string
  priority: number // Lower = higher priority
}

/** Result of a single validation layer. */
export interface ValidationResult {
  kind: "task-creation" | "audit-log" | "ci-evidence" | "ok"
  reason?: string
  planSteps?: ActionPlanItem[]
}

/** Shared context for all validators. */
export interface CompletionAuditContext {
  cwd: string
  sessionId: string
  transcript: string
  home: string
  tasksDir: string
  gates: CompletionValidationGate
  allTasks: SessionTask[]
  toolCallCount: number
  taskToolUsed: boolean
  observedToolNames: string[]
  summary: TranscriptSummary | null
}

/** Final result from orchestrated validation. */
export interface CompletionAuditResult {
  blocked: boolean
  reason?: string
  planSteps?: ActionPlanItem[]
}
