import { beforeEach, describe, expect, test } from "bun:test"
import {
  evaluatePosttoolusefailureRetryAdvisor,
  RETRY_ADVISORY_THRESHOLD,
  resetFailureStreaks,
} from "./posttoolusefailure-retry-advisor.ts"

function failure(sessionId: string, toolName: string) {
  return {
    hook_event_name: "PostToolUseFailure",
    session_id: sessionId,
    cwd: "/tmp/project",
    tool_name: toolName,
    tool_input: {},
  }
}

function contextText(output: unknown): string {
  const o = output as { hookSpecificOutput?: { additionalContext?: string } }
  return o.hookSpecificOutput?.additionalContext ?? ""
}

describe("posttoolusefailure-retry-advisor", () => {
  beforeEach(() => {
    resetFailureStreaks()
  })

  test("stays silent on a single failure", () => {
    const out = evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Bash"))
    expect(out).toEqual({})
  })

  test("advises once the same tool fails at the threshold", () => {
    evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Bash"))
    const out = evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Bash"))
    // Message text is rephrased downstream — assert an advisory was emitted with
    // non-empty context rather than matching exact (mutable) wording.
    expect(out).not.toEqual({})
    expect(contextText(out).length).toBeGreaterThan(0)
  })

  test("resets the streak when a different tool fails", () => {
    evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Bash"))
    const out = evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Edit"))
    expect(out).toEqual({})
  })

  test("tracks streaks independently per session", () => {
    evaluatePosttoolusefailureRetryAdvisor(failure("s1", "Bash"))
    const other = evaluatePosttoolusefailureRetryAdvisor(failure("s2", "Bash"))
    expect(other).toEqual({})
  })

  test("ignores payloads missing session_id or tool_name", () => {
    expect(evaluatePosttoolusefailureRetryAdvisor(failure("", "Bash"))).toEqual({})
    expect(evaluatePosttoolusefailureRetryAdvisor(failure("s1", ""))).toEqual({})
  })

  test("ignores malformed input", () => {
    expect(evaluatePosttoolusefailureRetryAdvisor(null)).toEqual({})
    expect(evaluatePosttoolusefailureRetryAdvisor("nope")).toEqual({})
  })

  test("threshold constant is the documented value", () => {
    expect(RETRY_ADVISORY_THRESHOLD).toBe(2)
  })
})
