import {
  missingRefinementCategories,
  NEEDS_REFINEMENT_NORM,
  normaliseLabel,
} from "../../src/issue-refinement.ts"
import { type ActionPlanItem, formatActionPlan, skillExists } from "../../src/utils/hook-utils.ts"
import { MAX_SHOWN_ISSUES, REVIEWABLE_BLOCK_NORM } from "./constants.ts"
import { planSectionOrderForProjectState, statePriorityHint } from "./project-state.ts"
import type { StopContext, StopSection } from "./types.ts"

function buildRefinementSteps(ctx: StopContext): ActionPlanItem[] {
  const shownRefinement = ctx.sortedRefinement.slice(0, MAX_SHOWN_ISSUES)
  const hiddenRefinement = ctx.sortedRefinement.length - shownRefinement.length
  const issueListParts = shownRefinement.map((issue) => {
    const hasExplicitLabel = issue.labels.some(
      (l) => normaliseLabel(l.name) === NEEDS_REFINEMENT_NORM
    )
    const missing = missingRefinementCategories(issue)
    const tag = hasExplicitLabel ? "[needs-refinement]" : `[missing labels: ${missing.join(", ")}]`
    return `#${issue.number} ${issue.title} ${tag}`
  })
  if (hiddenRefinement > 0) issueListParts.push(`…and ${hiddenRefinement} more`)
  const refineArg = ctx.firstRefinementNum !== undefined ? ` ${ctx.firstRefinementNum}` : ""
  const subSteps: ActionPlanItem[] = []
  if (skillExists("refine-issue"))
    subSteps.push(`/refine-issue${refineArg} — Refine the next issue needing attention`)
  subSteps.push(
    "Every issue MUST have at least one label from each category: Type (bug, enhancement, documentation), Readiness (ready, triaged, backlog), Priority (priority-high, priority-medium, priority-low)",
    "Run gh label list to check available labels",
    'Label issues: gh issue edit <number> --add-label "bug,ready,priority-high" --remove-label "needs-triage"',
    "Rule: If you created the issue, NEVER add new comments — always edit the original issue body instead"
  )
  return [
    `Refine ${ctx.sortedRefinement.length} issue(s) before implementation: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

function buildIssuePickupSteps(ctx: StopContext): ActionPlanItem[] {
  const issueContext = ctx.isPersonalRepo
    ? "in this personal repository"
    : "assigned to or created by you"
  const shownIssues = ctx.sortedIssues.slice(0, MAX_SHOWN_ISSUES)
  const hiddenCount = ctx.sortedIssues.length - shownIssues.length
  const issueListParts = shownIssues.map((issue) => `#${issue.number} ${issue.title}`)
  if (hiddenCount > 0) issueListParts.push(`…and ${hiddenCount} more`)
  const issueArg = ctx.firstIssueNum !== undefined ? ` ${ctx.firstIssueNum}` : ""
  const issueNum = ctx.firstIssueNum ?? "<number>"
  const subSteps: ActionPlanItem[] = []
  if (skillExists("work-on-issue"))
    subSteps.push(`/work-on-issue${issueArg} — Start working on the next issue`)
  subSteps.push(
    `Read the full issue body AND all comments for #${issueNum} before planning — comments contain refinements, automation output, and acceptance criteria updates`,
    `Check for existing work: search for linked PRs and git fetch origin --prune`
  )
  if (!ctx.strictNoDirectMain) {
    subSteps.push(
      `If an open PR for #${issueNum} exists with passing checks → merge it; if checks failing → fix them; if no PR → implement`
    )
  }
  subSteps.push(
    `Claim ownership: gh issue edit ${issueNum} --add-assignee @me`,
    "Verify branch starting point: git branch --show-current (must be main), git pull --rebase --autostash",
    `Plan with TaskCreate before touching any code for issue #${issueNum}`,
    `Check for blockers on #${issueNum}: inspect labels and body for blocked/depends-on references`,
    "Quality checks (MANDATORY before commit): bun run typecheck && bun run lint && bun test --concurrent",
    `Resolve: swiz issue resolve ${issueNum} --body "<evidence>"`
  )
  return [
    `Pick up ${ctx.sortedIssues.length} open issue(s) ${issueContext}: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

function buildBlockedIssueReviewSteps(ctx: StopContext): ActionPlanItem[] {
  const shownBlocked = ctx.blockedIssues.slice(0, MAX_SHOWN_ISSUES)
  const hiddenBlocked = ctx.blockedIssues.length - shownBlocked.length
  const issueListParts = shownBlocked.map((issue) => {
    const blockLabel = (issue.labels ?? []).find((l) =>
      REVIEWABLE_BLOCK_NORM.has(normaliseLabel(l.name))
    )
    const tag = blockLabel ? ` [${blockLabel.name}]` : ""
    return `#${issue.number} ${issue.title}${tag}`
  })
  if (hiddenBlocked > 0) issueListParts.push(`…and ${hiddenBlocked} more`)
  const firstBlocked = ctx.blockedIssues[0]
  const blockedNum = firstBlocked?.number ?? "<number>"
  const subSteps: ActionPlanItem[] = []
  subSteps.push(
    `Read the latest comments on #${blockedNum} to understand the block reason — dependencies, upstream issues, or missing information`,
    `Check if the blocking condition has been resolved (e.g., dependency issue closed, upstream fix merged)`,
    `If unblockable: remove the block label and add a readiness label: gh issue edit ${blockedNum} --remove-label "blocked" --add-label "ready"`,
    `If still blocked: document current status in a comment and move to the next blocked issue`
  )
  if (skillExists("refine-issue"))
    subSteps.push(`/refine-issue ${blockedNum} — Refine and re-label the unblocked issue`)
  if (skillExists("triage-issues"))
    subSteps.push("/triage-issues — Run the full grooming workflow across the backlog")
  return [
    `Review ${ctx.blockedIssues.length} blocked issue(s) — dependencies may have been resolved: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

const planStepBuilders: Record<StopSection, (ctx: StopContext) => ActionPlanItem[] | null> = {
  refinement: (ctx) => (ctx.sortedRefinement.length > 0 ? buildRefinementSteps(ctx) : null),
  readyIssues: (ctx) => (ctx.sortedIssues.length > 0 ? buildIssuePickupSteps(ctx) : null),
  blocked: (ctx) => (ctx.blockedIssues.length > 0 ? buildBlockedIssueReviewSteps(ctx) : null),
}

export function buildStopPlanSteps(ctx: StopContext): ActionPlanItem[] {
  const planSteps: ActionPlanItem[] = []
  for (const key of planSectionOrderForProjectState(ctx.projectState)) {
    const steps = planStepBuilders[key](ctx)
    if (steps) planSteps.push(...steps)
  }
  return planSteps
}

/** Intro paragraphs for issue-focused stop messaging (before numbered steps). */
export function formatStopIssuesIntro(stopCtx: StopContext): string {
  const headerParts = [
    "There are open issues that need your attention before we can finish the session.",
  ]
  if (stopCtx.projectState != null) {
    headerParts.push(statePriorityHint(stopCtx.projectState))
  }
  return headerParts.join("\n")
}

export function formatStopReason(planSteps: ActionPlanItem[], ctx: StopContext): string {
  return formatActionPlan(planSteps, {
    translateToolNames: true,
    header: formatStopIssuesIntro(ctx),
  })
}
