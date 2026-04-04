import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { HookExecution } from "./engine.ts"
import { processBlockingResults } from "./strategies.ts"

function makeHookExecution(file: string, status: HookExecution["status"] = "ok"): HookExecution {
  return {
    file,
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    configuredTimeoutSec: 5,
    status,
    exitCode: 0,
    stdoutSnippet: "",
    stderrSnippet: "",
    ...(status === "skipped" ? { skipReason: "condition-false" as const } : {}),
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

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
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

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
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

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    const msg = finalResponse.systemMessage as string
    expect(msg).toContain("top-level-msg")
    expect(msg).toContain("nested-extra")
    expect(msg.indexOf("top-level-msg")).toBeLessThan(msg.indexOf("nested-extra"))
  })

  it("leaves finalResponse empty when there are no results", () => {
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults([], executions, finalResponse, "Stop")
    expect(finalResponse).toEqual({})
    expect(executions).toEqual([])
  })

  it("records skipped hooks without treating them as blocks", () => {
    const skip = makeHookExecution("skip.ts", "skipped")
    const blockExec = makeHookExecution("block.ts")
    const results = [
      { execution: skip, parsed: null },
      {
        execution: blockExec,
        parsed: {
          decision: "block",
          reason: "stop",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "ctx" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions).toHaveLength(2)
    expect(executions[0]?.status).toBe("skipped")
    expect(executions[1]?.status).toBe("block")
    expect(finalResponse.reason).toBe("stop")
    expect(finalResponse.systemMessage).toContain("ctx")
  })

  it("does not set systemMessage when first block has no extractable context", () => {
    const results = [
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "only-reason",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toBeUndefined()
    expect(finalResponse.reason).toBe("only-reason")
  })

  it("ignores whitespace-only additionalContext for merge", () => {
    const results = [
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "r",
          stopReason: "blocked",
          systemMessage: "top",
          hookSpecificOutput: { decision: "block", additionalContext: "  \t  " },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toBe("top")
  })

  it("treats continue false as a block and still merges nested context", () => {
    const results = [
      {
        execution: makeHookExecution("c.ts"),
        parsed: {
          continue: false,
          reason: "nope",
          hookSpecificOutput: {
            additionalContext: "from-continue-false",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toContain("from-continue-false")
    expect(finalResponse.continue).toBe(false)
  })

  it("detects block from hookSpecificOutput.decision only", () => {
    const results = [
      {
        execution: makeHookExecution("nested.ts"),
        parsed: {
          hookSpecificOutput: {
            decision: "block",
            reason: "inner",
            additionalContext: "nested-block-ctx",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions[0]?.status).toBe("block")
    expect(finalResponse.systemMessage).toContain("nested-block-ctx")
  })

  it("orders non-block context before first block context in systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("allow.ts"),
        parsed: {
          hookSpecificOutput: { additionalContext: "pre-block" },
        },
      },
      {
        execution: makeHookExecution("block.ts"),
        parsed: {
          decision: "block",
          reason: "first",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-block",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    const msg = finalResponse.systemMessage as string
    expect(msg.indexOf("pre-block")).toBeLessThan(msg.indexOf("from-block"))
  })

  it("records aborted hooks without merging their parsed output", () => {
    const aborted = makeHookExecution("gone.ts", "aborted")
    const results = [
      { execution: aborted, parsed: { decision: "block", reason: "ignored" } },
      {
        execution: makeHookExecution("real.ts"),
        parsed: {
          decision: "block",
          reason: "winner",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "ac" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions[0]?.status).toBe("aborted")
    expect(finalResponse.reason).toBe("winner")
    expect(finalResponse.systemMessage).toContain("ac")
  })

  it("handles null parsed after a passing hook with no output", () => {
    const results = [
      { execution: makeHookExecution("empty.ts"), parsed: null },
      {
        execution: makeHookExecution("block.ts"),
        parsed: {
          decision: "block",
          reason: "x",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "c" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions).toHaveLength(2)
    expect(executions[0]?.status).toBe("ok")
    expect(finalResponse.systemMessage).toBe("c")
  })

  it("sets hookSpecificOutput for PostToolUse-style context-only aggregation", () => {
    const results = [
      {
        execution: makeHookExecution("posttooluse-git-context.ts"),
        parsed: {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: "[git] On branch main tracking origin/main. Working tree is clean.",
          },
          systemMessage: "[git] On branch main tracking origin/main. Working tree is clean.",
          suppressOutput: true,
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "PostToolUse")
    const hso = finalResponse.hookSpecificOutput as Record<string, any>
    expect(hso?.hookEventName).toBe("PostToolUse")
    expect(hso?.additionalContext).toBe(
      "[git] On branch main tracking origin/main. Working tree is clean."
    )
    expect(finalResponse.systemMessage).toContain("On branch main")
  })
})

describe("BlockingStrategy stop aggregation", () => {
  it("stop events must NOT abort on first block — they aggregate all responses", () => {
    // Stop events use a collection window (STOP_COLLECTION_TIMEOUT_MS) to let all
    // hooks race fairly. Slower hooks like stop-personal-repo-issues (GitHub API)
    // were previously starved by fast file-based checks that blocked first.
    //
    // The onResult for stop events must be undefined (no early abort).
    // Non-stop events still abort on first block.
    const source = readFileSync(join(import.meta.dir, "strategies.ts"), "utf-8")

    // The BlockingStrategy must use processAggregatedStopResults for stop events
    expect(source).toContain("processAggregatedStopResults")

    // Non-stop events must still abort on first block
    const nonStopAbort = source.match(
      /onResult:\s*isStop\s*\?\s*undefined\s*:\s*\(result,\s*abort\)\s*=>/
    )
    expect(nonStopAbort).not.toBeNull()

    // Stop events must use a collection timeout
    expect(source).toContain("STOP_COLLECTION_TIMEOUT_MS")
    expect(source).toContain("collectionTimeoutMs: isStop ? STOP_COLLECTION_TIMEOUT_MS")
  })
})
