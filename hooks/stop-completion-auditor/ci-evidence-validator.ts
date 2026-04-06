/**
 * CI Evidence Requirement Validator
 *
 * Requires proof of CI success (green/pass/success) when git push occurred.
 * Checks task completion evidence and subject lines for CI mentions.
 * Blocks stop if push happened but no CI evidence exists.
 */

import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import {
  computeTranscriptSummary,
  formatActionPlan,
  mergeActionPlanIntoTasks,
} from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem, CompletionAuditContext, ValidationResult } from "./types.ts"

const CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i

function taskHasCiEvidence(t: SessionTask): boolean {
  return (
    (!!t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
    (!!t.subject && CI_EVIDENCE_RE.test(t.subject))
  )
}

function anyTaskHasCiEvidence(tasks: SessionTask[]): boolean {
  return tasks.filter((t) => t.status === "completed").some(taskHasCiEvidence)
}

/**
 * Search sibling sessions (by transcript) for CI evidence.
 * Reads all sibling task files in parallel via {@link Promise.all}.
 */
async function findCiEvidenceInSiblings(
  transcript: string,
  sessionId: string,
  home: string
): Promise<boolean> {
  const projectDir = dirname(transcript)
  try {
    const files = await readdir(projectDir)
    const siblingIds = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6))
      .filter((id) => id !== sessionId)

    if (siblingIds.length === 0) return false

    // Parallel read of sibling task files
    const results = await Promise.all(
      siblingIds.map(async (sibId) => {
        try {
          const tasksDir = `${home}/.claude/tasks/${sibId}`
          const files = await readdir(tasksDir)
          const taskFiles = files.filter((f) => f.endsWith(".json"))
          const tasks: SessionTask[] = []
          for (const f of taskFiles) {
            try {
              const content = await Bun.file(`${tasksDir}/${f}`).json()
              tasks.push(content)
            } catch {}
          }
          return anyTaskHasCiEvidence(tasks)
        } catch {
          return false
        }
      })
    )
    return results.some(Boolean)
  } catch {
    return false
  }
}

export async function validateCiEvidence(ctx: CompletionAuditContext): Promise<ValidationResult> {
  // Skip validation if gate is disabled
  if (!ctx.gates.ciEvidence) return { kind: "ok" }

  // Determine if push occurred by checking transcript summary
  const effectiveSummary = ctx.summary ?? (await computeTranscriptSummary(ctx.transcript))
  if (!(effectiveSummary?.hasGitPush ?? false)) return { kind: "ok" }

  // Check for CI evidence in current session tasks
  let hasCiEvidence = anyTaskHasCiEvidence(ctx.allTasks)

  // If not found locally, search sibling sessions
  if (!hasCiEvidence && ctx.transcript) {
    hasCiEvidence = await findCiEvidenceInSiblings(ctx.transcript, ctx.sessionId, ctx.home)
  }

  // If still not found, block with guidance
  if (!hasCiEvidence) {
    const planSteps: ActionPlanItem[] = [
      {
        description: 'Create a "Push and verify CI" task and mark it in_progress.',
        priority: 1,
      },
      {
        description: "Run CI verification: swiz ci-wait <SHA> or gh run view --json conclusion.",
        priority: 2,
      },
      {
        description:
          "Mark the task completed via TaskUpdate (status completed), recording evidence such as: note:CI green — conclusion: success, run <run-id>",
        priority: 3,
      },
    ]

    await mergeActionPlanIntoTasks(
      planSteps.map((s) => s.description),
      ctx.sessionId,
      ctx.cwd
    )

    return {
      kind: "ci-evidence",
      reason:
        "All tasks are completed but none have CI verification evidence.\n\n" +
        "The push+CI lifecycle rule requires a completed task with evidence " +
        "confirming CI passed (e.g. 'CI green', 'conclusion: success').\n\n" +
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
