import { describe, expect, test } from "bun:test"
import { canonicalReadiness, READINESS_GUIDANCE } from "../../src/issue-refinement.ts"
import { buildIssueStopAction, buildStopPlanSteps } from "./action-plan.ts"
import { buildStopContext, classifyStopIssues } from "./context.ts"
import type { Issue } from "./types.ts"

function issue(number: number, states: string[], nativeChildCount?: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    labels: ["bug", "priority-medium", ...states].map((name) => ({ name })),
    nativeChildCount,
  }
}

function context(issues: Issue[]) {
  return buildStopContext(
    {
      cwd: "/fixture",
      sessionId: "readiness-test",
      rawSessionId: "readiness-test",
      isPersonalRepo: true,
      currentUser: "test",
    },
    classifyStopIssues(issues, "fixture/readiness"),
    null,
    false,
    "main"
  )
}

describe("Stop canonical readiness", () => {
  test.each([
    "ready",
    "backlog",
    "blocked",
    "waiting",
    "needs-breakdown",
  ])("%s has one state and only ready is pickable", (state) => {
    const item = issue(1, [state], 1)
    const result = classifyStopIssues([item], "fixture/readiness")
    expect(canonicalReadiness(item)).toEqual([state])
    expect(result.sortedRefinement).toEqual([])
    expect(result.sortedIssues.map((entry) => entry.number)).toEqual(state === "ready" ? [1] : [])
  })

  test("decomposed Hub parent shapes preserve ready-child selection", () => {
    const parents = [313, 91, 10, 4].map((number) => issue(number, ["needs-breakdown"], 2))
    const ctx = context([
      ...parents,
      issue(341, ["ready"]),
      issue(277, ["blocked"]),
      issue(92, ["waiting"]),
    ])!
    expect(ctx.sortedRefinement).toEqual([])
    expect(ctx.sortedIssues.map((entry) => entry.number)).toEqual([341])
    expect(buildIssueStopAction(ctx)?.instruction).toContain("/work-on-issue 341")
  })

  test("missing and conflicting readiness receive different repair guidance", () => {
    const ctx = context([issue(1, []), issue(2, ["ready", "waiting"])])!
    const plan = JSON.stringify(buildStopPlanSteps(ctx))
    expect(ctx.sortedIssues).toEqual([])
    expect(plan).toContain("missing readiness")
    expect(plan).toContain("conflicting readiness: ready, waiting")
    expect(plan).toContain(READINESS_GUIDANCE)
    expect(plan).not.toContain("triaged")
  })

  test("missing or unverified decomposition remains reviewable", () => {
    const ctx = context([issue(1, ["needs-breakdown"], 0), issue(2, ["needs-breakdown"])])!
    const plan = JSON.stringify(buildStopPlanSteps(ctx))
    expect(ctx.sortedRefinement).toHaveLength(2)
    expect(ctx.sortedIssues).toEqual([])
    expect(plan).toContain("missing native child decomposition")
    expect(plan).toContain("native child decomposition unverified")
    expect(plan).not.toContain("missing readiness")
  })

  test("valid parent readiness does not suppress missing type or priority", () => {
    const parent = issue(1, ["needs-breakdown"], 2)
    parent.labels = [{ name: "needs-breakdown" }]
    const plan = JSON.stringify(buildStopPlanSteps(context([parent])!))
    expect(plan).toContain("missing type")
    expect(plan).toContain("missing priority")
    expect(plan).not.toContain("missing readiness")
  })

  test("terminal skip labels still exclude issues from readiness repair", () => {
    const invalid = issue(1, ["ready", "waiting", "duplicate"])
    expect(context([invalid])).toBeNull()
  })

  test("waiting evidence and same-repository dependency checks remain distinct", () => {
    const ctx = context([issue(1, ["blocked"]), issue(2, ["waiting"])])!
    expect(ctx.blockedIssues).toHaveLength(2)
    const plan = JSON.stringify(buildStopPlanSteps(ctx))
    expect(plan).toContain("open same-repository dependency")
    expect(plan).toContain("external decision or evidence with its named owner")
    expect(plan).not.toContain('--add-label \\"ready\\"')
  })
})
