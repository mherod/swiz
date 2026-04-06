import {
  type ActionPlanItem,
  formatActionPlan,
  skillAdvice,
  skillExists,
} from "../../src/utils/hook-utils.ts"
import { selectRebaseSuggestionPRs } from "./pull-requests.ts"
import type { StopContext } from "./types.ts"

/** Count of PRs with pending review feedback (changes requested + review required). */
export function feedbackPrCount(
  ctx: Pick<StopContext, "changesRequestedPRs" | "reviewRequiredPRs">
): number {
  return ctx.changesRequestedPRs.length + ctx.reviewRequiredPRs.length
}

function buildConflictSteps(ctx: StopContext): ActionPlanItem[] {
  const { shown: shownConflictingPRs, hiddenCount: hiddenConflictingPRs } =
    selectRebaseSuggestionPRs(ctx.conflictingPRs)
  const prListParts = shownConflictingPRs.map((pr) => `#${pr.number} ${pr.title}`)
  if (hiddenConflictingPRs > 0) {
    prListParts.push(`…and ${hiddenConflictingPRs} more`)
  }
  const rebaseAdvice = skillAdvice(
    "rebase-onto-main",
    "/rebase-onto-main --push — Rebase and resolve conflicts",
    "Rebase manually: git fetch origin && git checkout <branch> && git rebase origin/<base-branch> && git push --force-with-lease"
  )
  const resolveAdvice = skillAdvice(
    "resolve-conflicts",
    "/resolve-conflicts — Resolve any rebase conflicts",
    "Resolve conflicts: edit files, remove markers, git add <file>, git rebase --continue"
  )
  return [
    `Rebase ${ctx.conflictingPRs.length} open PR(s) with merge conflicts: ${prListParts.join("; ")}`,
    [rebaseAdvice, resolveAdvice],
  ]
}

function buildPrFeedbackSteps(ctx: StopContext): ActionPlanItem[] {
  const feedbackPRs = [...ctx.changesRequestedPRs, ...ctx.reviewRequiredPRs]
  const allChangesRequested = feedbackPRs.every((p) => p.reviewDecision === "CHANGES_REQUESTED")
  const label = allChangesRequested
    ? "changes requested"
    : "pending feedback (CHANGES_REQUESTED or REVIEW_REQUIRED)"
  const prListLines = feedbackPRs.map((pr) => {
    const decisionTag =
      pr.reviewDecision === "CHANGES_REQUESTED" ? "[changes requested]" : "[review required]"
    return `#${pr.number} ${pr.title} ${decisionTag}`
  })
  const firstPrNum =
    ctx.changesRequestedPRs[0]?.number ?? ctx.reviewRequiredPRs[0]?.number ?? "<number>"
  const subSteps: ActionPlanItem[] = []
  if (skillExists("work-on-prs")) subSteps.push("/work-on-prs — Start working on the next PR")
  subSteps.push(
    `Read ALL feedback for PR #${firstPrNum}: top-level comments, inline review comments, and review summaries`,
    "Implement a fix for each unresolved item; commit each fix separately",
    "Run quality checks: bun run typecheck && bun run lint && bun test",
    `Push and verify CI: git push && gh pr checks ${firstPrNum}`,
    `Dismiss stale CHANGES_REQUESTED reviews and request re-review: gh pr edit ${firstPrNum} --add-reviewer <reviewer>`
  )
  return [
    `Address ${feedbackPRs.length} open PR(s) with ${label}: ${prListLines.join("; ")}`,
    subSteps,
  ]
}

const planStepBuilders: Record<
  "feedback" | "conflict",
  (ctx: StopContext) => ActionPlanItem[] | null
> = {
  feedback: (ctx) => (feedbackPrCount(ctx) > 0 ? buildPrFeedbackSteps(ctx) : null),
  conflict: (ctx) => (ctx.conflictingPRs.length > 0 ? buildConflictSteps(ctx) : null),
}

export function buildStopPlanSteps(ctx: StopContext): ActionPlanItem[] {
  const planSteps: ActionPlanItem[] = []

  // Order: feedback first, then conflicts
  for (const key of ["feedback", "conflict"] as const) {
    const steps = planStepBuilders[key](ctx)
    if (steps) planSteps.push(...steps)
  }

  return planSteps
}

export function formatStopReason(planSteps: ActionPlanItem[]): string {
  const headerParts = [
    "There are open pull requests with feedback or merge conflicts that need your attention before we can finish the session.",
  ]

  return formatActionPlan(planSteps, {
    translateToolNames: true,
    header: headerParts.join("\n"),
  })
}
