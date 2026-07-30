import { describe, expect, test } from "bun:test"
import { isBlock } from "../src/dispatch/engine.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { evaluateStopLifecycleTasks } from "./stop-lifecycle-tasks.ts"

describe("stop-lifecycle-tasks", () => {
  test("returns an advisory without blocking when lifecycle tasks remain", () => {
    const input: StopHookInput = {
      _activeLifecycleTasks: [
        {
          taskId: "task-1",
          subject: "Compile assets",
          teamName: "frontend",
          teammateName: "worker-a",
          createdAt: 10,
        },
      ],
    }
    const result = evaluateStopLifecycleTasks(input)

    expect(isBlock(result)).toBe(false)
    expect(result).toMatchObject({
      systemMessage: expect.stringContaining("frontend/worker-a"),
      hookSpecificOutput: {
        additionalContext: expect.stringContaining("task-1: Compile assets"),
      },
    })
  })

  test("fails open when the injected snapshot is absent or malformed", () => {
    const emptyInput: StopHookInput = {}
    expect(evaluateStopLifecycleTasks(emptyInput)).toEqual({})
    const malformedInput: StopHookInput = {
      _activeLifecycleTasks: [{ taskId: "task-1" }],
    }
    expect(evaluateStopLifecycleTasks(malformedInput)).toEqual({})
  })
})
