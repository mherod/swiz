import { afterEach, describe, expect, test } from "bun:test"
import { renderTask } from "./task-renderer.ts"

const originalConsoleLog = console.log

afterEach(() => {
  console.log = originalConsoleLog
})

describe("renderTask", () => {
  test("renders inline elapsed duration for in-progress tasks", () => {
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "))
    }

    const startedAt = Date.now() - 12 * 60_000
    renderTask(
      {
        id: "1",
        subject: "Verify CI passes",
        description: "",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
        startedAt,
        completedAt: null,
        statusChangedAt: new Date(startedAt).toISOString(),
        elapsedMs: 0,
      },
      undefined,
      "absolute"
    )

    expect(lines[0]).toContain("(12m)")
    expect(lines[0]).toContain("Verify CI passes")
  })
})
