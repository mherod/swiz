import { describe, expect, test } from "bun:test"
import { evaluateStopIncompleteTasks } from "./evaluate.ts"

describe("evaluateStopIncompleteTasks _fastPathTaskScanComplete", () => {
  test("returns {} immediately when _fastPathTaskScanComplete is set", async () => {
    // The dispatch CLI sets this flag after tryStopFastPath found no blockers.
    // The hook must honour it for both "stop" and "subagentStop" events.
    const result = await evaluateStopIncompleteTasks({
      _fastPathTaskScanComplete: true,
    } as unknown as import("../../src/schemas.ts").StopHookInput)
    expect(result).toEqual({})
  })
})
