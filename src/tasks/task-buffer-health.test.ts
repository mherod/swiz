import { describe, expect, test } from "bun:test"
import {
  hadHealthyPendingTaskBufferBeforeTaskCreate,
  hasHealthyPendingTaskBuffer,
  hasHealthyTaskBuffer,
} from "./task-buffer-health.ts"

describe("task buffer health", () => {
  test("requires at least two pending tasks for a healthy pending buffer", () => {
    expect(hasHealthyPendingTaskBuffer([{ status: "in_progress" }, { status: "pending" }])).toBe(
      false
    )
    expect(hasHealthyPendingTaskBuffer([{ status: "pending" }, { status: "pending" }])).toBe(true)
  })

  test("discounts the just-created task when checking post-create health", () => {
    expect(
      hadHealthyPendingTaskBufferBeforeTaskCreate(
        [
          { status: "pending", subject: "Existing one" },
          { status: "pending", subject: "Fix auth and update tests" },
        ],
        "Fix auth and update tests"
      )
    ).toBe(false)
    expect(
      hadHealthyPendingTaskBufferBeforeTaskCreate(
        [
          { status: "pending", subject: "Existing one" },
          { status: "pending", subject: "Existing two" },
          { status: "pending", subject: "Fix auth and update tests" },
        ],
        "Fix auth and update tests"
      )
    ).toBe(true)
  })

  test("requires both pending buffer and active work for healthy task buffer", () => {
    expect(hasHealthyTaskBuffer([{ status: "pending" }, { status: "pending" }])).toBe(false)
    expect(
      hasHealthyTaskBuffer([
        { status: "in_progress" },
        { status: "pending" },
        { status: "pending" },
      ])
    ).toBe(true)
  })
})
