import { describe, expect, it } from "vitest"
import { getAgent, translateEvent } from "./agents.ts"
import {
  codexCommonInputSchema,
  codexHookOutputSchema,
  codexPostToolUseInputSchema,
  codexPreToolUseInputSchema,
  codexSessionStartInputSchema,
  codexStopInputSchema,
  codexUserPromptSubmitInputSchema,
} from "./schemas.ts"

/**
 * Contract for Codex CLI hooks.json: the public hook surface is
 * SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, and Stop.
 * Swiz must install only those public keys and must not regress to internal
 * engine identifiers.
 */
describe("Codex eventMap contract (hooks.json)", () => {
  const codex = getAgent("codex")!

  it("maps canonical public events to shipped JSON keys", () => {
    expect(codex.eventMap.stop).toBe("Stop")
    expect(codex.eventMap.preToolUse).toBe("PreToolUse")
    expect(codex.eventMap.postToolUse).toBe("PostToolUse")
    expect(codex.eventMap.sessionStart).toBe("SessionStart")
    expect(codex.eventMap.userPromptSubmit).toBe("UserPromptSubmit")
  })

  it("translateEvent matches eventMap for shipped keys", () => {
    expect(translateEvent("stop", codex)).toBe("Stop")
    expect(translateEvent("preToolUse", codex)).toBe("PreToolUse")
    expect(translateEvent("postToolUse", codex)).toBe("PostToolUse")
    expect(translateEvent("sessionStart", codex)).toBe("SessionStart")
    expect(translateEvent("userPromptSubmit", codex)).toBe("UserPromptSubmit")
  })

  it("marks non-public events unsupported so install skips them", () => {
    expect(codex.unsupportedEvents).toEqual([
      "sessionEnd",
      "preCompact",
      "notification",
      "subagentStart",
      "subagentStop",
    ])
  })

  it("installs hooks now that Codex ships a stable hooks.json format", () => {
    expect(codex.hooksConfigurable).toBe(true)
  })
})

describe("Codex hook schema contracts", () => {
  it("codexCommonInputSchema parses a typical Codex payload", () => {
    const result = codexCommonInputSchema.safeParse({
      cwd: "/repo",
      session_id: "sess-1",
      hook_event_name: "SessionStart",
      transcript_path: null,
      model: "o3",
    })
    expect(result.success).toBe(true)
    expect(result.data!.transcript_path).toBeNull()
    expect(result.data!.model).toBe("o3")
  })

  it("codexSessionStartInputSchema accepts startup and resume sources", () => {
    for (const source of ["startup", "resume"] as const) {
      const result = codexSessionStartInputSchema.safeParse({
        cwd: "/repo",
        session_id: "sess-1",
        source,
        model: "o3",
      })
      expect(result.success).toBe(true)
      expect(result.data!.source).toBe(source)
    }
  })

  it("codexPreToolUseInputSchema NFKC-normalizes command", () => {
    const result = codexPreToolUseInputSchema.safeParse({
      cwd: "/repo",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "e\u0301cho hello" },
    })
    expect(result.success).toBe(true)
    expect(result.data!.tool_input!.command).toBe("\u00E9cho hello")
  })

  it("codexPostToolUseInputSchema accepts tool_response", () => {
    const result = codexPostToolUseInputSchema.safeParse({
      cwd: "/repo",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      tool_response: '{"output":"file1.ts"}',
    })
    expect(result.success).toBe(true)
    expect(result.data!.tool_response).toBe('{"output":"file1.ts"}')
  })

  it("codexUserPromptSubmitInputSchema parses prompt field", () => {
    const result = codexUserPromptSubmitInputSchema.safeParse({
      cwd: "/repo",
      turn_id: "turn-1",
      prompt: "fix the bug",
    })
    expect(result.success).toBe(true)
    expect(result.data!.prompt).toBe("fix the bug")
  })

  it("codexStopInputSchema accepts nullable last_assistant_message", () => {
    const result = codexStopInputSchema.safeParse({
      cwd: "/repo",
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: null,
    })
    expect(result.success).toBe(true)
    expect(result.data!.last_assistant_message).toBeNull()
    expect(result.data!.stop_hook_active).toBe(false)
  })

  it("codexHookOutputSchema accepts block with reason", () => {
    const result = codexHookOutputSchema.safeParse({
      decision: "block",
      reason: "Destructive command blocked.",
    })
    expect(result.success).toBe(true)
  })

  it("codexHookOutputSchema accepts hookSpecificOutput with permissionDecision", () => {
    const result = codexHookOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Blocked by policy.",
      },
    })
    expect(result.success).toBe(true)
  })

  it("codexHookOutputSchema accepts continue with stopReason", () => {
    const result = codexHookOutputSchema.safeParse({
      continue: false,
      stopReason: "Hook requested stop.",
    })
    expect(result.success).toBe(true)
  })

  it("codexHookOutputSchema rejects empty object", () => {
    const result = codexHookOutputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it("all Codex schemas preserve unknown fields (looseObject forward-compat)", () => {
    const result = codexPreToolUseInputSchema.safeParse({
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "echo" },
      future_field: "preserved",
    })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, any>).future_field).toBe("preserved")
  })
})
