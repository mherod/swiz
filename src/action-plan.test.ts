import { describe, expect, it } from "vitest"
import { formatActionPlan } from "./action-plan.ts"
import { getAgent } from "./agents.ts"

describe("formatActionPlan", () => {
  it("uses Codex planning aliases without mentioning unavailable task readers", () => {
    const codex = getAgent("codex")!
    const result = formatActionPlan(
      [
        "Run TaskList now.",
        "Use TaskCreate or TaskUpdate to update task state.",
        "Retry after TaskGet confirms the task.",
      ],
      { translateToolNames: true, agent: codex }
    )

    expect(result).toContain("Use update_plan to update task state")
    expect(result).not.toContain("TaskList")
    expect(result).not.toContain("TaskGet")
    expect(result).not.toContain("TaskUpdate")
    expect(result).not.toContain("update_plan or update_plan")
  })
})
