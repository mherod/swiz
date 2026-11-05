import { describe, expect, it } from "bun:test"
import {
  bareTaskId,
  collectSessionOwnedTaskIds,
  isTaskOwnedBySession,
} from "./session-task-ownership.ts"

function toolUse(id: string, name: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  })
}

function toolResult(id: string, text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
    },
  })
}

describe("collectSessionOwnedTaskIds", () => {
  it("claims tasks the session created, recovered or moved through a status transition", () => {
    const owned = collectSessionOwnedTaskIds([
      toolUse("a", "mcp__swiz__TaskCreate"),
      toolResult("a", '{"summary":"Created #0e3a-10 — Build it\\n\\nREADY (1)"}'),
      toolUse("b", "mcp__swiz__TaskCreate"),
      toolResult("b", "Recovered #0e3a-11 — Same work (no change)"),
      toolUse("c", "TaskCreate"),
      toolResult("c", "Task #7 created successfully: Native work"),
      toolUse("d", "mcp__swiz__TaskUpdate"),
      toolResult("d", "Updated #0e3a-12 — Take over (pending → in_progress; description)"),
    ])
    expect([...owned].sort()).toEqual(["0e3a-10", "0e3a-11", "0e3a-12", "7"])
  })

  it("does not treat a description-only note as a claim", () => {
    const owned = collectSessionOwnedTaskIds([
      toolUse("d", "mcp__swiz__TaskUpdate"),
      toolResult("d", "Updated #0e3a-2714 — App Store listing (description)"),
    ])
    expect(owned.size).toBe(0)
  })

  it("ignores matching text in results of non-task tools", () => {
    const owned = collectSessionOwnedTaskIds([
      toolUse("e", "Bash"),
      toolResult("e", "Created #0e3a-99 — echoed by a shell command"),
    ])
    expect(owned.size).toBe(0)
  })
})

describe("isTaskOwnedBySession", () => {
  const owned = new Set(["0e3a-10"])

  it("owns its own session store and never another session's", () => {
    expect(
      isTaskOwnedBySession({ id: "1", storeKey: { kind: "session", id: "s1" } }, "s1", owned)
    ).toBe(true)
    expect(
      isTaskOwnedBySession({ id: "1", storeKey: { kind: "session", id: "s2" } }, "s1", owned)
    ).toBe(false)
  })

  it("owns a project row only with transcript evidence, including qualified ids", () => {
    const project = { kind: "project", key: "-p" } as const
    expect(isTaskOwnedBySession({ id: "0e3a-10", storeKey: project }, "s1", owned)).toBe(true)
    expect(isTaskOwnedBySession({ id: "project:-p#0e3a-10", storeKey: project }, "s1", owned)).toBe(
      true
    )
    expect(isTaskOwnedBySession({ id: "0e3a-2714", storeKey: project }, "s1", owned)).toBe(false)
  })

  it("keeps rows without a store address governed as before", () => {
    expect(isTaskOwnedBySession({ id: "1" }, "s1", new Set())).toBe(true)
    expect(bareTaskId("#5")).toBe("5")
  })
})
