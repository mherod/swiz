import { describe, expect, test } from "bun:test"
import { orderHookContexts } from "./context-order.ts"

describe("orderHookContexts", () => {
  test("keeps short context lists in encounter order", () => {
    expect(orderHookContexts(["first", "second"], "Stop")).toEqual(["first", "second"])
  })

  test("deduplicates repeated context before ordering", () => {
    expect(orderHookContexts(["same", "same\n", "other"], "PostToolUse")).toEqual(["same", "other"])
  })

  test("stably shuffles longer context lists within a time bucket", () => {
    const originalNow = Date.now
    Date.now = () => 1_710_000_000_000
    try {
      const ordered = orderHookContexts(["alpha", "beta", "gamma"], "Stop")
      expect(ordered).toEqual(["beta", "gamma", "alpha"])
      expect(orderHookContexts(["alpha", "beta", "gamma"], "Stop")).toEqual(ordered)
    } finally {
      Date.now = originalNow
    }
  })
})
