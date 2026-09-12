import { describe, expect, test } from "bun:test"
import { missingRefinementCategories, needsRefinement } from "./issue-refinement.ts"

const issue = (states: string[]) => ({
  number: 313,
  title: "Coordination parent",
  labels: ["bug", "priority-high", ...states].map((name) => ({ name })),
})

describe("canonical readiness", () => {
  test.each([
    "ready",
    "backlog",
    "blocked",
    "waiting",
    "needs-breakdown",
  ])("%s satisfies readiness without becoming another state", (state) => {
    expect(missingRefinementCategories(issue([state]))).toEqual([])
    expect(needsRefinement(issue([state]))).toBe(false)
  })

  test("conflicting states need refinement without being missing", () => {
    expect(missingRefinementCategories(issue(["ready", "waiting"]))).toEqual([])
    expect(needsRefinement(issue(["ready", "waiting"]))).toBe(true)
  })

  test("no canonical state is missing readiness, even with a legacy alias", () => {
    expect(missingRefinementCategories(issue(["triaged"]))).toEqual(["readiness"])
  })
})
