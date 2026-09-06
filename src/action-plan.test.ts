import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatActionPlan, mergeActionPlanIntoTasks } from "./action-plan.ts"
import { getAgent } from "./agents.ts"
import { acquireEnvLock, releaseEnvLockFn, useTempDir } from "./utils/test-utils.ts"

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

describe("mergeActionPlanIntoTasks settings tiers", () => {
  const steps = ["Add the missing guard to the upload handler"]
  const tempDirs = useTempDir("swiz-action-plan-tiers-")

  async function mergeWithTiers(options: {
    globalMerge: boolean
    projectMerge?: boolean
  }): Promise<number> {
    const root = await tempDirs.create()
    const home = join(root, "home")
    const project = join(root, "project")
    await mkdir(join(home, ".swiz"), { recursive: true })
    await mkdir(join(project, ".swiz"), { recursive: true })
    await Bun.write(
      join(home, ".swiz", "settings.json"),
      JSON.stringify({ actionPlanMerge: options.globalMerge })
    )
    if (options.projectMerge !== undefined) {
      await Bun.write(
        join(project, ".swiz", "config.json"),
        JSON.stringify({ actionPlanMerge: options.projectMerge })
      )
    }

    // Fresh temp paths per call, so the settings and project caches cannot serve a
    // previous scenario's value.
    await acquireEnvLock()
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      return await mergeActionPlanIntoTasks(steps, `session-${crypto.randomUUID()}`, project)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      releaseEnvLockFn()
    }
  }

  it("lets a project override enable merging when the global value is false", async () => {
    // #875: the gate read the global tier only, so a project opting in did nothing.
    expect(await mergeWithTiers({ globalMerge: false, projectMerge: true })).toBeGreaterThan(0)
  })

  it("lets a project override disable merging when the global value is true", async () => {
    // The same bug in the other direction: a project could not opt out.
    expect(await mergeWithTiers({ globalMerge: true, projectMerge: false })).toBe(0)
  })

  it("falls back to the global value when no project override exists", async () => {
    // Control pair. Without it the two overrides above would pass equally well against
    // a gate hardcoded to ignore settings, or one that always consulted the project file.
    expect(await mergeWithTiers({ globalMerge: true })).toBeGreaterThan(0)
    expect(await mergeWithTiers({ globalMerge: false })).toBe(0)
  })
})
