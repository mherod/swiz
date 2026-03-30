import { describe, expect, it } from "bun:test"
import type { HookExecution } from "./engine.ts"
import { processBlockingResults } from "./strategies.ts"

function makeHookExecution(file: string): HookExecution {
  return {
    file,
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    configuredTimeoutSec: 5,
    status: "ok",
    exitCode: 0,
    stdoutSnippet: "",
    stderrSnippet: "",
  }
}

describe("processBlockingResults", () => {
  it("merges first block additionalContext into systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("first.ts"),
        parsed: {
          decision: "block",
          reason: "first",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "first-block-only-context",
          },
        },
      },
    ]

    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse)
    expect(finalResponse.systemMessage).toContain("first-block-only-context")
    expect(finalResponse.decision).toBe("block")
    expect(finalResponse.reason).toBe("first")
  })

  it("merges first and second block additionalContext into systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("a.ts"),
        parsed: {
          decision: "block",
          reason: "a",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-first",
          },
        },
      },
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "b",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-second",
          },
        },
      },
    ]

    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse)
    expect(finalResponse.systemMessage).toContain("from-first")
    expect(finalResponse.systemMessage).toContain("from-second")
    expect(finalResponse.reason).toBe("a")
  })

  it("appends first block additionalContext after existing systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("one.ts"),
        parsed: {
          decision: "block",
          reason: "r",
          stopReason: "blocked",
          systemMessage: "top-level-msg",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "nested-extra",
          },
        },
      },
    ]

    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse)
    const msg = finalResponse.systemMessage as string
    expect(msg).toContain("top-level-msg")
    expect(msg).toContain("nested-extra")
    expect(msg.indexOf("top-level-msg")).toBeLessThan(msg.indexOf("nested-extra"))
  })
})
