import { describe, expect, test } from "bun:test"
import { sanitizeHookOutputForAgent } from "./hook-output-agent-compat.ts"

describe("sanitizeHookOutputForAgent", () => {
  test("leaves non-Codex hook output unchanged", () => {
    const output = {
      suppressOutput: true,
      systemMessage: "visible",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "nested context",
      },
    }

    expect(sanitizeHookOutputForAgent(output, "claude")).toBe(output)
  })

  test("omits additionalContext for Codex and preserves it as systemMessage", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "session guidance",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      systemMessage: "session guidance",
    })
  })

  test("flattens multiline Codex context with full stops", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        systemMessage: "top\nlevel",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "first line\nsecond line",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      systemMessage: "top. level first line. second line",
    })
  })

  test("does not duplicate existing Codex line punctuation", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "already done.\nwhat next?\nkeep going!",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      systemMessage: "already done. what next? keep going!",
    })
  })

  test("uses PreToolUse allow reason as Codex systemMessage instead of additionalContext", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "use update_plan",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      systemMessage: "use update_plan",
    })
  })

  test("removes Codex additionalContext without duplicating an existing systemMessage", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        systemMessage: "git push succeeded.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "git push succeeded.",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      systemMessage: "git push succeeded.",
    })
  })
})
