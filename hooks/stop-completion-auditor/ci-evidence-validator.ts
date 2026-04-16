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

/** Matches bash commands that perform explicit CI verification. */
const CI_CMD_RE = /gh run (?:view|watch)|swiz ci.?wait/

function taskHasCiEvidence(t: SessionTask): boolean {
  return (
    (!!t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
    (!!t.description && CI_EVIDENCE_RE.test(t.description)) ||
    (!!t.subject && CI_EVIDENCE_RE.test(t.subject))
  )
}

function anyTaskHasCiEvidence(tasks: SessionTask[]): boolean {
  return tasks.filter((t) => t.status === "completed").some(taskHasCiEvidence)
}

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

async function gatherCiEvidence(
  ctx: CompletionAuditContext,
  effectiveSummary: { bashCommands?: string[] }
): Promise<boolean> {
  if (anyTaskHasCiEvidence(ctx.allTasks)) return true
  if (ctx.allTasks.length === 0) {
    const bashCmds = effectiveSummary.bashCommands ?? []
    if (bashCmds.some((cmd) => CI_CMD_RE.test(cmd))) return true
  }
  if (ctx.transcript) {
    return await findCiEvidenceInSiblings(ctx.transcript, ctx.sessionId, ctx.home)
  }
  return false
}

function buildCiEvidenceBlockPlan(): ActionPlanItem[] {
  return [
    { description: 'Create a "Push and verify CI" task and mark it in_progress.', priority: 1 },
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
}

export async function validateCiEvidence(ctx: CompletionAuditContext): Promise<ValidationResult> {
  if (!ctx.gates.ciEvidence) return { kind: "ok" }

  const effectiveSummary = ctx.summary ?? (await computeTranscriptSummary(ctx.transcript))
  if (!(effectiveSummary?.hasGitPush ?? false)) return { kind: "ok" }

  const hasCiEvidence = await gatherCiEvidence(ctx, effectiveSummary ?? {})
  if (hasCiEvidence) return { kind: "ok" }

  const planSteps = buildCiEvidenceBlockPlan()
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
