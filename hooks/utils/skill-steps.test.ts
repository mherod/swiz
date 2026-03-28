import { describe, expect, it } from "bun:test"
import { z } from "zod"
import type { Task } from "../../src/tasks/task-repository.ts"
import { formatSkillStepsSummary } from "./skill-steps.ts"

// ─── RefinedStepsSchema validation ──────────────────────────────────────────

const RefinedStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        subject: z.string(),
        description: z.string(),
      })
    )
    .min(3),
})

describe("RefinedStepsSchema", () => {
  it("accepts 3+ well-formed steps", () => {
    const input = {
      steps: [
        { subject: "Run lint checks", description: "Execute biome and eslint" },
        { subject: "Fix type errors", description: "Resolve all tsc failures" },
        { subject: "Commit changes", description: "Stage and commit fixes" },
      ],
    }
    const result = RefinedStepsSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it("rejects fewer than 3 steps", () => {
    const input = {
      steps: [
        { subject: "Run lint", description: "Check lint" },
        { subject: "Fix errors", description: "Fix them" },
      ],
    }
    const result = RefinedStepsSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it("rejects steps missing description", () => {
    const input = {
      steps: [{ subject: "Run lint" }, { subject: "Fix errors" }, { subject: "Commit" }],
    }
    const result = RefinedStepsSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it("rejects empty steps array", () => {
    const result = RefinedStepsSchema.safeParse({ steps: [] })
    expect(result.success).toBe(false)
  })
})

// ─── formatSkillStepsSummary ────────────────────────────────────────────────

describe("formatSkillStepsSummary", () => {
  it("formats created tasks with skill name", () => {
    const result = formatSkillStepsSummary({
      skillName: "commit",
      created: [
        { id: "abc-1", subject: "Stage files" } as Task,
        { id: "abc-2", subject: "Run commit" } as Task,
      ],
    })
    expect(result).toContain("Created 2 task(s) from /commit steps:")
    expect(result).toContain("#abc-1: Stage files")
    expect(result).toContain("#abc-2: Run commit")
  })

  it("handles single task", () => {
    const result = formatSkillStepsSummary({
      skillName: "push",
      created: [{ id: "x-1", subject: "Push to remote" } as Task],
    })
    expect(result).toContain("Created 1 task(s) from /push steps:")
  })
})
