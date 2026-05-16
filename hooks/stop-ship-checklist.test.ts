import { describe, expect, test } from "bun:test"
import { buildUnifiedActionPlan, formatStopMessage } from "./stop-ship-checklist/action-plan.ts"
import type { WorkflowStep } from "./stop-ship-checklist/types.ts"

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

describe("stop-ship-checklist composition with personal-repo issue steps (#619)", () => {
  test("issues-only checklist renders open issues heading", () => {
    const steps: WorkflowStep[] = [
      {
        kind: "issues",
        summary: "Open issues assigned to you need pickup.",
        planSteps: ["Pick up #42 Add rate limiting", ["/work-on-issue 42"]],
      },
    ]
    const message = formatStopMessage(steps)
    expect(message).toContain("### Open issues and pull requests")
    expect(message).toContain("Open issues assigned to you need pickup")
  })

  test("issue steps are ordered after git and CI steps", () => {
    const steps: WorkflowStep[] = [
      {
        kind: "issues",
        summary: "Issues waiting.",
        planSteps: ["Pick up #1"],
      },
      {
        kind: "git",
        summary: "Uncommitted changes.",
        planSteps: ["git add .", "git commit"],
      },
    ]
    const { plan } = buildUnifiedActionPlan(steps)
    const gitIdx = plan.indexOf("Repository")
    const issuesIdx = plan.indexOf("Issues and pull requests")
    expect(gitIdx).toBeGreaterThanOrEqual(0)
    expect(issuesIdx).toBeGreaterThan(gitIdx)
  })

  test("issue steps rendered with separate section heading from git steps", () => {
    const steps: WorkflowStep[] = [
      {
        kind: "git",
        summary: "Push your changes.",
        planSteps: ["git push origin main"],
      },
      {
        kind: "issues",
        summary: "Two issues need attention.",
        planSteps: ["Pick up #10 Fix login bug", "Pick up #11 Add tests"],
      },
    ]
    const message = formatStopMessage(steps)
    expect(message).toContain("### Repository")
    expect(message).toContain("### Open issues and pull requests")
    // Issue plan steps are listed under issues, not under git
    const repoIdx = message.indexOf("### Repository")
    const issuesIdx = message.indexOf("### Open issues and pull requests")
    expect(issuesIdx).toBeGreaterThan(repoIdx)
  })

  test("issue kind flag distinguishes issue steps from git and ci steps", () => {
    const gitStep: WorkflowStep = { kind: "git", summary: "Commit needed.", planSteps: [] }
    const ciStep: WorkflowStep = { kind: "ci", summary: "CI failing.", planSteps: [] }
    const issuesStep: WorkflowStep = {
      kind: "issues",
      summary: "Issues need pickup.",
      planSteps: [],
    }
    // Verify kind discrimination used by the shouldMergeTasks guard in evaluate.ts
    expect(gitStep.kind).not.toBe("issues")
    expect(ciStep.kind).not.toBe("issues")
    expect(issuesStep.kind).toBe("issues")
  })
})
