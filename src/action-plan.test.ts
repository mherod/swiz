import { describe, expect, it } from "vitest"
import { formatActionPlan } from "./action-plan.ts"
import { getAgent } from "./agents.ts"

describe("formatActionPlan", () => {
  it("omits unavailable task readers for Codex without update_plan", () => {
    const codex = getAgent("codex")!
    const result = formatActionPlan(
      [
        "Run TaskList now.",
        "Use TaskCreate or TaskUpdate to update task state.",
        "Retry after TaskGet confirms the task.",
      ],
      { translateToolNames: true, agent: codex }
    )

    expect(result).toContain("Use TaskCreate or TaskUpdate to update task state")
    expect(result).not.toContain("TaskList")
    expect(result).not.toContain("TaskGet")
    expect(result).not.toContain("update_plan")
  })

  it("omits TaskList action steps for Cursor", () => {
    const cursor = getAgent("cursor")!
    const result = formatActionPlan(
      ["Run TaskList now.", "Use TaskUpdate to refresh task state."],
      { translateToolNames: true, agent: cursor }
    )

    expect(result).toContain("Use TodoWrite to refresh task state")
    expect(result).not.toContain("TaskList")
  })

  it("omits TaskList action steps for non-Claude agents without TaskList", () => {
    const gemini = getAgent("gemini")!
    const result = formatActionPlan(
      ["Run TaskList now.", "Retry this Bash call after the task queue is ready."],
      { translateToolNames: true, agent: gemini }
    )

    expect(result).toContain("Retry this")
    expect(result).toContain("after the task queue is ready")
    expect(result).not.toContain("TaskList")
  })
})
