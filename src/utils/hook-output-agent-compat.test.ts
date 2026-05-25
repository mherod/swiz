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

  test("mirrors PreToolUse deny reason into Codex top-level block fields", () => {
    const output = sanitizeHookOutputForAgent<Record<string, unknown>>(
      {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked for testing",
        },
      },
      "codex"
    )

    expect(output).toEqual({
      decision: "block",
      reason: "blocked for testing",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked for testing",
      },
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

describe("sanitizeHookOutputForAgent tool-name translation", () => {
  test("leaves canonical tool names untranslated for Claude (identity)", () => {
    const output = {
      reason: "Run TaskList then use Bash to commit.",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "Create tasks with TaskCreate before Edit.",
      },
    }
    expect(sanitizeHookOutputForAgent(output, "claude")).toBe(output)
  })

  test("translates canonical tool names to Cursor names in reason", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      { reason: "Use Bash to run the command, then Edit the file." },
      "cursor"
    )
    expect(output.reason).toBe("Use Shell to run the command, then StrReplace the file.")
  })

  test("translates and collapses duplicate task aliases for Cursor", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Use TaskCreate or TaskUpdate to track work.",
        },
      },
      "cursor"
    )
    expect(output.hookSpecificOutput.additionalContext).toBe("Use TodoWrite to track work.")
  })

  test("translates tool names to Gemini names", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      { systemMessage: "Bash then Read the file." },
      "gemini"
    )
    expect(output.systemMessage).toBe("run_shell_command then read_file the file.")
  })

  test("translates canonical names for Codex after envelope reshaping", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "Use Edit to apply the change, then Bash to verify.",
        },
      },
      "codex"
    )
    expect(output.systemMessage).toBe(
      "Use apply_patch to apply the change, then shell_command to verify."
    )
  })

  test("returns original reference when no tool names present", () => {
    const output = { reason: "All checks passed; nothing to do." }
    expect(sanitizeHookOutputForAgent(output, "cursor")).toBe(output)
  })

  test("does not collapse ordinary repeated prose words", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      { reason: "Try again and again until Bash succeeds." },
      "cursor"
    )
    expect(output.reason).toBe("Try again and again until Shell succeeds.")
  })

  test("leaves untranslatable task tools (Codex TaskList) as-is", () => {
    const output = sanitizeHookOutputForAgent<Record<string, any>>(
      { systemMessage: "Run TaskList to check state." },
      "codex"
    )
    expect(output.systemMessage).toBe("Run TaskList to check state.")
  })
})
