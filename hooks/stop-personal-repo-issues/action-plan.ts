import { type ActionPlanItem, formatActionPlan } from "../../src/action-plan.ts"
import {
  NEEDS_REFINEMENT_NORM,
  normaliseLabel,
  READINESS_GUIDANCE,
  refinementReasons,
} from "../../src/issue-refinement.ts"
import { skillExistsForHookPayload } from "../../src/skill-utils.ts"
import { type StopAction, stopActionId } from "../../src/stop-actions.ts"
import { getTaskToolName } from "../../src/tasks/task-governance-messages.ts"
import { MAX_SHOWN_ISSUES, REVIEWABLE_BLOCK_NORM } from "./constants.ts"
import { planSectionOrderForProjectState, statePriorityHint } from "./project-state.ts"
import type { StopContext, StopSection } from "./types.ts"

/** Select one issue using the existing readiness/priority order, never the whole backlog. */
export function buildIssueStopAction(ctx: StopContext): StopAction | undefined {
  for (const section of planSectionOrderForProjectState(ctx.projectState)) {
    const issues =
      section === "readyIssues"
        ? ctx.sortedIssues
        : section === "refinement"
          ? ctx.sortedRefinement
          : ctx.blockedIssues
    const issue = issues[0]
    if (!issue) continue
    const refine = section !== "readyIssues"
    return {
      id: stopActionId(ctx.cwd, refine ? "refine-issue" : "work-on-issue", String(issue.number)),
      kind: "issue",
      title: `${refine ? "Review" : "Work on"} issue #${issue.number}`,
      reason: issue.title,
      instruction: `Run /${refine ? "refine-issue" : "work-on-issue"} ${issue.number}. Read the full body and comments; check blockers and existing work before implementation.`,
      doneWhen: refine
        ? "Readiness and the next owned action are evidenced."
        : "The selected issue has verified delivery or an evidenced blocker and owner.",
    }
  }
  return undefined
}

function buildRefinementSteps(
  ctx: StopContext,
  payload?: Record<string, unknown>
): ActionPlanItem[] {
  const shownRefinement = ctx.sortedRefinement.slice(0, MAX_SHOWN_ISSUES)
  const hiddenRefinement = ctx.sortedRefinement.length - shownRefinement.length
  const issueListParts = shownRefinement.map((issue) => {
    const hasExplicitLabel = issue.labels.some(
      (l) => normaliseLabel(l.name) === NEEDS_REFINEMENT_NORM
    )
    const reasons = refinementReasons(issue)
    if (hasExplicitLabel) reasons.unshift("needs-refinement")
    const tag = `[${reasons.join("; ")}]`
    return `#${issue.number} ${issue.title} ${tag}`
  })
  if (hiddenRefinement > 0) issueListParts.push(`…and ${hiddenRefinement} more`)
  const refineArg = ctx.firstRefinementNum !== undefined ? ` ${ctx.firstRefinementNum}` : ""
  const subSteps: ActionPlanItem[] = []
  if (skillExistsForHookPayload("refine-issue", payload ?? {}))
    subSteps.push(`/refine-issue${refineArg} — Refine the next issue needing attention`)
  subSteps.push(
    "Every issue MUST have a Type (bug, enhancement, documentation) and Priority (priority-high, priority-medium, priority-low).",
    READINESS_GUIDANCE,
    "Run gh label list to check available labels",
    "Remove needs-refinement only after the missing categories or conflicting states are resolved.",
    "For needs-breakdown, inspect native children and the bounded residual before choosing work. Create missing child decomposition; retain a decomposed parent and select eligible ready children independently.",
    "Rule: If you created the issue, NEVER add new comments — always edit the original issue body instead"
  )
  return [
    `Refine ${ctx.sortedRefinement.length} issue(s) before implementation: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

function buildIssuePickupSteps(
  ctx: StopContext,
  payload?: Record<string, unknown>
): ActionPlanItem[] {
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
  if (skillExistsForHookPayload("work-on-issue", payload ?? {}))
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
    `Verify branch starting point: git branch --show-current, then check out the correct base (default: ${ctx.defaultBranch}; or an existing feature branch / PR head if one exists for this issue), git pull --rebase --autostash`,
    `Plan with ${getTaskToolName("TaskCreate")} before touching any code for issue #${issueNum}`,
    `Check for blockers on #${issueNum}: inspect labels and body for blocked/depends-on references`,
    "Quality checks (MANDATORY before commit): bun run typecheck && bun run lint && bun test --reporter=dots --parallel=4",
    `Resolve: swiz issue resolve ${issueNum} --body "<evidence>"`
  )
  return [
    `Pick up ${ctx.sortedIssues.length} open issue(s) ${issueContext}: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

function buildBlockedIssueReviewSteps(
  ctx: StopContext,
  payload?: Record<string, unknown>
): ActionPlanItem[] {
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
    "For blocked, verify the open same-repository dependency and its current state. For waiting, verify the external decision or evidence with its named owner; a closed dependency alone does not resolve an external wait.",
    READINESS_GUIDANCE,
    "When the documented condition is resolved, replace the current state with the appropriate single readiness label.",
    `If still blocked: document current status in a comment and move to the next blocked issue`
  )
  if (skillExistsForHookPayload("refine-issue", payload ?? {}))
    subSteps.push(`/refine-issue ${blockedNum} — Refine and re-label the unblocked issue`)
  if (skillExistsForHookPayload("triage-issues", payload ?? {}))
    subSteps.push("/triage-issues — Run the full grooming workflow across the backlog")
  return [
    `Review ${ctx.blockedIssues.length} blocked issue(s) — dependencies may have been resolved: ${issueListParts.join("; ")}`,
    subSteps,
  ]
}

const planStepBuilders: Record<
  StopSection,
  (ctx: StopContext, payload?: Record<string, unknown>) => ActionPlanItem[] | null
> = {
  refinement: (ctx, payload) =>
    ctx.sortedRefinement.length > 0 ? buildRefinementSteps(ctx, payload) : null,
  readyIssues: (ctx, payload) =>
    ctx.sortedIssues.length > 0 ? buildIssuePickupSteps(ctx, payload) : null,
  blocked: (ctx, payload) =>
    ctx.blockedIssues.length > 0 ? buildBlockedIssueReviewSteps(ctx, payload) : null,
}

export function buildStopPlanSteps(
  ctx: StopContext,
  payload?: Record<string, unknown>
): ActionPlanItem[] {
  const planSteps: ActionPlanItem[] = []
  for (const key of planSectionOrderForProjectState(ctx.projectState)) {
    const steps = planStepBuilders[key](ctx, payload)
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
