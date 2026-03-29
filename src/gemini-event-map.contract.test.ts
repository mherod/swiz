import { describe, expect, it } from "vitest"
import {
  geminiAfterAgentInputSchema,
  geminiAfterModelInputSchema,
  geminiAfterToolInputSchema,
  geminiBeforeAgentInputSchema,
  geminiBeforeModelInputSchema,
  geminiBeforeToolInputSchema,
  geminiBeforeToolSelectionInputSchema,
  geminiHookOutputSchema,
  geminiNotificationInputSchema,
  geminiSessionEndInputSchema,
  geminiSessionStartInputSchema,
} from "../hooks/schemas.ts"
import { getAgent, translateEvent } from "./agents.ts"

describe("Gemini eventMap contract (settings.json)", () => {
  const gemini = getAgent("gemini")!

  it("maps canonical events to Gemini-native names", () => {
    expect(gemini.eventMap.stop).toBe("AfterAgent")
    expect(gemini.eventMap.sessionStart).toBe("SessionStart")
    expect(gemini.eventMap.userPromptSubmit).toBe("BeforeAgent")
    expect(gemini.eventMap.preToolUse).toBe("BeforeTool")
    expect(gemini.eventMap.postToolUse).toBe("AfterTool")
    expect(gemini.eventMap.preCompact).toBe("PreCompress")
    expect(gemini.eventMap.notification).toBe("Notification")
    expect(gemini.eventMap.sessionEnd).toBe("SessionEnd")
  })

  it("translateEvent matches eventMap", () => {
    expect(translateEvent("stop", gemini)).toBe("AfterAgent")
    expect(translateEvent("preToolUse", gemini)).toBe("BeforeTool")
    expect(translateEvent("postToolUse", gemini)).toBe("AfterTool")
  })

  it("installs hooks via settings.json", () => {
    expect(gemini.hooksConfigurable).toBe(true)
  })
})

describe("Gemini hook schema contracts", () => {
  it("geminiSessionStartInputSchema accepts startup/resume/clear", () => {
    for (const source of ["startup", "resume", "clear"] as const) {
      const result = geminiSessionStartInputSchema.safeParse({
        cwd: "/repo",
        session_id: "sess-1",
        source,
      })
      expect(result.success).toBe(true)
      expect(result.data!.source).toBe(source)
    }
  })

  it("geminiSessionEndInputSchema parses reason", () => {
    const result = geminiSessionEndInputSchema.safeParse({
      cwd: "/repo",
      reason: "exit",
    })
    expect(result.success).toBe(true)
    expect(result.data!.reason).toBe("exit")
  })

  it("geminiBeforeAgentInputSchema parses prompt", () => {
    const result = geminiBeforeAgentInputSchema.safeParse({
      cwd: "/repo",
      prompt: "fix the tests",
    })
    expect(result.success).toBe(true)
    expect(result.data!.prompt).toBe("fix the tests")
  })

  it("geminiAfterAgentInputSchema parses stop fields", () => {
    const result = geminiAfterAgentInputSchema.safeParse({
      cwd: "/repo",
      stop_hook_active: true,
      last_assistant_message: "Done.",
    })
    expect(result.success).toBe(true)
    expect(result.data!.stop_hook_active).toBe(true)
  })

  it("geminiBeforeModelInputSchema parses model and prompt", () => {
    const result = geminiBeforeModelInputSchema.safeParse({
      cwd: "/repo",
      model: "gemini-2.5-pro",
      prompt: "explain this code",
    })
    expect(result.success).toBe(true)
    expect(result.data!.model).toBe("gemini-2.5-pro")
  })

  it("geminiAfterModelInputSchema accepts response payload", () => {
    const result = geminiAfterModelInputSchema.safeParse({
      cwd: "/repo",
      model: "gemini-2.5-pro",
      response: { text: "Here is the explanation..." },
    })
    expect(result.success).toBe(true)
  })

  it("geminiBeforeToolSelectionInputSchema accepts tool list", () => {
    const result = geminiBeforeToolSelectionInputSchema.safeParse({
      cwd: "/repo",
      available_tools: ["run_shell_command", "write_file", "read_file"],
    })
    expect(result.success).toBe(true)
    expect(result.data!.available_tools).toHaveLength(3)
  })

  it("geminiBeforeToolInputSchema NFKC-normalizes tool_input strings", () => {
    const result = geminiBeforeToolInputSchema.safeParse({
      cwd: "/repo",
      tool_name: "run_shell_command",
      tool_input: { command: "e\u0301cho hello" },
    })
    expect(result.success).toBe(true)
    expect((result.data!.tool_input as Record<string, string>).command).toBe("\u00E9cho hello")
  })

  it("geminiAfterToolInputSchema accepts tool_response", () => {
    const result = geminiAfterToolInputSchema.safeParse({
      cwd: "/repo",
      tool_name: "run_shell_command",
      tool_input: { command: "ls" },
      tool_response: "file1.ts\nfile2.ts",
    })
    expect(result.success).toBe(true)
    expect(result.data!.tool_response).toBe("file1.ts\nfile2.ts")
  })

  it("geminiNotificationInputSchema parses notification fields", () => {
    const result = geminiNotificationInputSchema.safeParse({
      cwd: "/repo",
      message: "Task complete",
      title: "Gemini",
      notification_type: "info",
    })
    expect(result.success).toBe(true)
    expect(result.data!.notification_type).toBe("info")
  })

  it("geminiHookOutputSchema accepts deny with reason", () => {
    const result = geminiHookOutputSchema.safeParse({
      decision: "deny",
      reason: "Blocked by security policy.",
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema accepts allow", () => {
    const result = geminiHookOutputSchema.safeParse({
      decision: "allow",
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema accepts retry for AfterAgent", () => {
    const result = geminiHookOutputSchema.safeParse({
      retry: true,
      reason: "Tests still failing.",
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema accepts filteredTools for BeforeToolSelection", () => {
    const result = geminiHookOutputSchema.safeParse({
      filteredTools: ["run_shell_command", "read_file"],
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema accepts updatedInput for BeforeTool", () => {
    const result = geminiHookOutputSchema.safeParse({
      updatedInput: { command: "echo safe" },
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema accepts mockResponse for BeforeModel", () => {
    const result = geminiHookOutputSchema.safeParse({
      mockResponse: "Mocked LLM response for testing.",
    })
    expect(result.success).toBe(true)
  })

  it("geminiHookOutputSchema rejects empty object", () => {
    const result = geminiHookOutputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it("all Gemini schemas preserve unknown fields (looseObject forward-compat)", () => {
    const result = geminiBeforeToolInputSchema.safeParse({
      cwd: "/repo",
      tool_name: "write_file",
      tool_input: { file_path: "/tmp/test" },
      future_field: "preserved",
    })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).future_field).toBe("preserved")
  })
})
