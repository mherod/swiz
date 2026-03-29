import { describe, expect, test } from "bun:test"

import {
  formatTaskCompleteCommand,
  formatTaskCompleteCommands,
  formatTaskList,
} from "../tasks/task-recovery.ts"

describe("task formatting helpers", () => {
  test("formatTaskList renders task bullets", () => {
    const text = formatTaskList([
      { id: "1", status: "pending", subject: "First task" },
      { id: "2", status: "in_progress", subject: "Second task" },
    ])

    expect(text).toBe("  • #1 [pending]: First task\n  • #2 [in_progress]: Second task")
  })

  test("formatTaskList adds bounded overflow summary", () => {
    const text = formatTaskList(
      [
        { id: "1", status: "pending", subject: "First task" },
        { id: "2", status: "pending", subject: "Second task" },
        { id: "3", status: "pending", subject: "Third task" },
      ],
      { limit: 2, overflowLabel: "incomplete task(s)" }
    )

    expect(text).toBe(
      "  • #1 [pending]: First task\n" +
        "  • #2 [pending]: Second task\n" +
        "  ... 1 more incomplete task(s)"
    )
  })

  test("formatTaskList truncates long subjects when subjectMaxLength is set", () => {
    const text = formatTaskList(
      [
        {
          id: "1",
          status: "pending",
          subject: "This subject is intentionally very long for truncation",
        },
      ],
      { subjectMaxLength: 20 }
    )

    expect(text).toBe("  • #1 [pending]: This subject is i...")
  })

  test("formatTaskCompleteCommand renders a single command", () => {
    expect(formatTaskCompleteCommand("<id>", "session-123", "note:done")).toBe(
      'swiz tasks complete <id> --session session-123 --evidence "note:done"'
    )
  })

  test("formatTaskCompleteCommands renders one command per task", () => {
    const text = formatTaskCompleteCommands(
      [{ id: "1" }, { id: "2" }],
      "session-123",
      "note:completed",
      { indent: "  " }
    )

    expect(text).toBe(
      '  swiz tasks complete 1 --session session-123 --evidence "note:completed"\n' +
        '  swiz tasks complete 2 --session session-123 --evidence "note:completed"'
    )
  })
})
