import { describe, expect, test } from "bun:test"
import {
  recordDivergenceToolCall,
  type SessionDivergenceState,
  snapshotSessionDivergence,
} from "../src/commands/daemon/divergence.ts"
import { filterDisabledHooks } from "../src/dispatch/filters.ts"
import { buildManifestForAgent } from "../src/manifest.ts"
import posttooluseTaskAdvisor, {
  evaluatePosttooluseTaskAdvisor,
} from "./posttooluse-task-advisor.ts"

const at = Date.parse("2026-09-17T12:00:00.000Z")
function fixture() {
  const states = new Map<string, SessionDivergenceState>()
  const record = (
    toolName: string,
    toolInput = {},
    movement: "task-create" | "task-update" | null = null,
    sessionId = "a"
  ) => recordDivergenceToolCall(states, { sessionId, toolName, toolInput, movement, nowMs: at })
  record("TaskCreate", {}, "task-create")
  return { states, record, snapshot: () => snapshotSessionDivergence(states, "a")! }
}
async function advise(snapshot: unknown, extra: Record<string, unknown> = {}) {
  const steers: unknown[][] = []
  const result = await evaluatePosttooluseTaskAdvisor(
    { agent: "claude", cwd: "/repo", session_id: "a", tool_name: "Edit", ...extra },
    {
      readSnapshot: () => Promise.resolve(snapshot),
      steer: (...args: unknown[]) => {
        steers.push(args)
        return Promise.resolve(true)
      },
    }
  )
  return { result, steers }
}

describe("weighted task advice", () => {
  test("the manifest covers shell and task calls without an edit-only matcher", () => {
    const groups = buildManifestForAgent({ tasksEnabled: true }).filter((group) =>
      group.hooks.some((entry) => "hook" in entry && entry.hook === posttooluseTaskAdvisor)
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.event).toBe("postToolUse")
    expect(groups[0]?.matcher).toBeUndefined()
    expect(posttooluseTaskAdvisor.matcher).toBeUndefined()
  })
  test("overlapping sessions keep their steering destinations", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    const release = Promise.withResolvers<unknown>()
    const destinations: unknown[][] = []
    const pending = evaluatePosttooluseTaskAdvisor(
      { agent: "claude", session_id: "a", cwd: "/a", tool_name: "Edit" },
      {
        readSnapshot: () => release.promise,
        steer: (...args: unknown[]) => {
          destinations.push(args)
          return Promise.resolve(true)
        },
      }
    )
    await advise(f.snapshot(), { session_id: "b", cwd: "/b" })
    release.resolve(f.snapshot())
    await pending
    expect(destinations[0]?.[0]).toBe("a")
    expect(destinations[0]?.[3]).toBe("/a")
  })
  test("a steering failure preserves advisory output", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    const result = await evaluatePosttooluseTaskAdvisor(
      { agent: "claude", session_id: "a", cwd: "/a", tool_name: "Edit" },
      {
        readSnapshot: () => Promise.resolve(f.snapshot()),
        steer: () => Promise.reject(new Error("transport unavailable")),
      }
    )
    expect(JSON.stringify(result)).toContain("30 weighted")
  })
  test("drained work and forty read-only calls stay silent", async () => {
    const f = fixture()
    for (let i = 0; i < 40; i++) f.record("Bash", { command: "git status --short" })
    expect(await advise(f.snapshot())).toEqual({ result: {}, steers: [] })
    f.record("Edit")
    f.record("TaskUpdate", {}, "task-update")
    expect(await advise(f.snapshot())).toEqual({ result: {}, steers: [] })
  })
  test("fifteen mutations advise and thirty steer without denying", async () => {
    const f = fixture()
    for (let i = 0; i < 14; i++) f.record("Edit")
    expect((await advise(f.snapshot())).result).toEqual({})
    f.record("Edit")
    const lower = await advise(f.snapshot())
    expect(JSON.stringify(lower.result)).toContain("15 weighted")
    expect(JSON.stringify(lower.result)).toContain("TaskCreate")
    expect(JSON.stringify(lower.result)).toContain("2026-09-17T12:00:00.000Z")
    expect(lower.steers).toHaveLength(0)
    for (let i = 0; i < 15; i++) f.record("Edit")
    const upper = await advise(f.snapshot())
    expect(JSON.stringify(upper.result)).toContain("30 weighted")
    expect(upper.steers).toHaveLength(1)
    expect(upper.steers[0]?.[0]).toBe("a")
    expect(upper.steers[0]?.[3]).toBe("/repo")
    expect(upper.result).not.toHaveProperty("decision")
    expect(upper.result).not.toHaveProperty("continue", false)
  })
  test("outward shell calls count twice and custom thresholds apply", async () => {
    const f = fixture()
    f.record("Bash", { command: "git push origin main" })
    f.record("Bash", { command: "gh issue comment 866 --body-file evidence.md" })
    const snapshot = { ...f.snapshot(), advisoryThreshold: 3, steerThreshold: 4 }
    const value = await advise(snapshot, { tool_name: "Bash" })
    expect(JSON.stringify(value.result)).toContain("4 weighted")
    expect(value.steers).toHaveLength(1)
  })
  test("task reads and confirmed no-op updates cannot silence the counter", async () => {
    const f = fixture()
    for (let i = 0; i < 15; i++) f.record("Edit")
    f.record("TaskList")
    expect(
      JSON.stringify((await advise(f.snapshot(), { tool_name: "TaskList" })).result)
    ).toContain("15 weighted")
    f.record("TaskUpdate")
    expect(
      JSON.stringify(
        (
          await advise(f.snapshot(), {
            tool_name: "mcp__swiz__TaskUpdate",
            tool_response: { structuredContent: { taskMutation: { changed: false } } },
          })
        ).result
      )
    ).toContain("15 weighted")
  })
  test("changed and unknown task outcomes do not advise from a stale snapshot", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    for (const tool_response of [{ structuredContent: { taskMutation: { changed: true } } }, {}]) {
      expect(await advise(f.snapshot(), { tool_name: "TaskUpdate", tool_response })).toEqual({
        result: {},
        steers: [],
      })
    }
  })
  test("missing, incomplete and malformed evidence stays silent", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    for (const snapshot of [
      null,
      {},
      { ...f.snapshot(), complete: false },
      { ...f.snapshot(), lastMovementAt: null },
      { ...f.snapshot(), weightedSum: NaN },
    ]) {
      expect(await advise(snapshot)).toEqual({ result: {}, steers: [] })
    }
  })
  test("session counters remain separate", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    f.record("TaskCreate", {}, "task-create", "b")
    expect(
      (await advise(snapshotSessionDivergence(f.states, "b"), { session_id: "b" })).result
    ).toEqual({})
    expect((await advise(f.snapshot())).steers).toHaveLength(1)
  })
  test("the existing disable path removes the advisory hook", () => {
    const filtered = filterDisabledHooks(
      [{ event: "postToolUse", hooks: [{ hook: posttooluseTaskAdvisor }] }],
      new Set(["posttooluse-task-advisor.ts"])
    )
    expect(filtered.flatMap((group) => group.hooks)).toHaveLength(0)
  })
  test("auto-steer disabled retains advisory context only", async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.record("Edit")
    const result = await advise(f.snapshot(), { _effectiveSettings: { autoSteer: false } })
    expect(JSON.stringify(result.result)).toContain("30 weighted")
    expect(result.steers).toHaveLength(0)
  })
})
