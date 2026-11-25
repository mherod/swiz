import { describe, expect, test } from "bun:test"
import type { ToolCallOutcome } from "../src/transcript-summary.ts"
import {
  TASK_TOOL_UNAVAILABLE_RE,
  TASK_TOOLS_UNREACHABLE_NOTE,
  taskToolsUnreachable,
} from "./pretooluse-task-governance.ts"

const call = (name: string, success: boolean, resultText = ""): ToolCallOutcome => ({
  name,
  success,
  resultText,
})

const DISCONNECTED =
  "Error: No such tool available: mcp__swiz__TaskList. Its MCP server 'swiz' has disconnected."
const GATE_DENIAL =
  "Sync task state before Bash. Cause: no canonical TaskList sync is recorded for this session"

describe("task gates release when the task tools are unreachable", () => {
  test("releases when the latest task-tool call failed as unavailable", () => {
    expect(
      taskToolsUnreachable([
        call("Bash", false, GATE_DENIAL),
        call("mcp__swiz__TaskList", false, DISCONNECTED),
        call("Read", true),
      ])
    ).toBe(true)
    expect(taskToolsUnreachable([call("TaskUpdate", false, "Connection closed")])).toBe(true)
    expect(
      taskToolsUnreachable([call("mcp__swiz__TaskCreate", false, "MCP server 'swiz' disconnected")])
    ).toBe(true)
  })

  test("control: a session that never tried a task tool is not released", () => {
    // Retrying the blocked command is not evidence that the remedy is impossible.
    expect(
      taskToolsUnreachable([
        call("Bash", false, GATE_DENIAL),
        call("Bash", false, GATE_DENIAL),
        call("Bash", false, GATE_DENIAL),
        call("Bash", false, GATE_DENIAL),
      ])
    ).toBe(false)
    expect(taskToolsUnreachable([])).toBe(false)
  })

  test("control: a task call denied by governance does not release the gates", () => {
    // Otherwise a deliberately rejected TaskCreate would switch every task gate off.
    const denied = "Task subject is compound. Split it into one action per task before creating it."
    expect(TASK_TOOL_UNAVAILABLE_RE.test(denied)).toBe(false)
    expect(taskToolsUnreachable([call("TaskCreate", false, denied)])).toBe(false)
    expect(taskToolsUnreachable([call("mcp__swiz__TaskList", false, GATE_DENIAL)])).toBe(false)
  })

  test("a later successful task call cancels an earlier failure", () => {
    expect(
      taskToolsUnreachable([
        call("mcp__swiz__TaskList", false, DISCONNECTED),
        call("mcp__swiz__TaskUpdate", true, "{}"),
      ])
    ).toBe(false)
  })

  test("a failure outside the trailing window no longer counts", () => {
    const outcomes = [
      call("TaskList", false, DISCONNECTED),
      ...Array.from({ length: 5 }, () => call("Read", true)),
    ]
    expect(taskToolsUnreachable(outcomes, 5)).toBe(false)
    expect(taskToolsUnreachable(outcomes, 6)).toBe(true)
  })

  test("unrelated tools with task-like names are ignored", () => {
    expect(taskToolsUnreachable([call("MyTaskListViewer", false, DISCONNECTED)])).toBe(false)
  })

  test("the release note says why and how to restore tracking", () => {
    expect(TASK_TOOLS_UNREACHABLE_NOTE).toContain("tool is unavailable")
    expect(TASK_TOOLS_UNREACHABLE_NOTE).toContain("Reconnect the task tools")
  })
})
