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

  test("does not render stale completion metadata for incomplete tasks", () => {
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "))
    }

    renderTask(
      {
        id: "2",
        subject: "Push branch to remote",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
        statusChangedAt: new Date().toISOString(),
        elapsedMs: 9 * 60_000,
        completedAt: Date.now() - 60_000,
        completionTimestamp: new Date(Date.now() - 60_000).toISOString(),
        completionEvidence: "test: stale",
      },
      undefined,
      "absolute"
    )

    expect(lines.join("\n")).not.toContain("Completed:")
    expect(lines.join("\n")).not.toContain("Evidence:")
    expect(lines.join("\n")).not.toContain("elapsed")
  })
})
