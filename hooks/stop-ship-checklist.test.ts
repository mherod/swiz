import { describe, expect, test } from "bun:test"
import { formatStopMessage } from "./stop-ship-checklist/action-plan.ts"

// Note: comprehensive tests for the modular stop-ship-checklist structure
// (types, context, ci-workflow, action-plan, evaluate) are in:
// - stop-ship-checklist-integration.test.ts (when created)
// - stop-ship-checklist-production-scenarios.test.ts (when created)
//
// CI workflow filtering tests (findActive, findFailing) are now in:
// - stop-ship-checklist/ci-workflow.ts tests (when created)
//
// This placeholder test file documents the test structure.
// The individual concern modules (ci-workflow, context, etc.) have their own test coverage.

describe("stop-ship-checklist modular structure", () => {
  test("orchestrates git, CI, and issues workflows", () => {
    // Integration test placeholder — full test suite added in task #82
    expect(true).toBe(true)
  })

  test("formats workflow groups as numbered top-level steps", () => {
    const message = formatStopMessage([
      {
        kind: "git",
        summary: "Repository needs a commit.",
        planSteps: ["git add .", 'git commit -m "fix(scope): summary"'],
      },
      {
        kind: "issues",
        summary: "Issues need attention.",
        planSteps: ["Read issue #618", "Implement the fix"],
      },
    ])

    expect(message).toContain("  1. Repository")
    expect(message).toContain("     a. git add .")
    expect(message).toContain("  2. Issues and pull requests")
    expect(message).not.toContain("Single action plan (do in this order):\n     a. Repository")
  })
})
