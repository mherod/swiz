import { describe, expect, it } from "bun:test"
import { normalizeAgentHookPayload } from "./payload-normalize.ts"

describe("normalizeAgentHookPayload", () => {
  it("maps Cursor conversation_id and workspace_roots to session_id and cwd", () => {
    const payload: Record<string, unknown> = {
      conversation_id: "4ed177ce-8642-4533-a539-2746a66351bd",
      generation_id: "5b15e1e1-5a8a-4781-9e51-a1100e6f42ef",
      hook_event_name: "stop",
      workspace_roots: ["/Users/matthewherod/Development/swiz"],
      transcript_path: "/tmp/transcript.jsonl",
    }
    normalizeAgentHookPayload(payload)
    expect(payload.session_id).toBe("4ed177ce-8642-4533-a539-2746a66351bd")
    expect(payload.cwd).toBe("/Users/matthewherod/Development/swiz")
    expect(payload.conversation_id).toBe("4ed177ce-8642-4533-a539-2746a66351bd")
  })

  it("does not overwrite existing session_id or cwd", () => {
    const payload: Record<string, unknown> = {
      session_id: "prior-session",
      cwd: "/prior/cwd",
      conversation_id: "cursor-id",
      workspace_roots: ["/other"],
    }
    normalizeAgentHookPayload(payload)
    expect(payload.session_id).toBe("prior-session")
    expect(payload.cwd).toBe("/prior/cwd")
  })

  it("maps Cursor beforeShellExecution shape to Bash + tool_input.command", () => {
    const payload: Record<string, unknown> = {
      conversation_id: "4ed177ce-8642-4533-a539-2746a66351bd",
      generation_id: "7324709e-7f5d-4e14-a8a2-08fe4c919273",
      model: "default",
      command: "cd /Users/matthewherod/Development/swiz && bun run typecheck 2>&1",
      cwd: "",
      sandbox: false,
      hook_event_name: "beforeShellExecution",
      cursor_version: "2.6.22",
      workspace_roots: ["/Users/matthewherod/Development/swiz"],
      user_email: "matthew.herod@gmail.com",
      transcript_path:
        "/Users/matthewherod/.cursor/projects/Users-matthewherod-Development-swiz/agent-transcripts/4ed177ce-8642-4533-a539-2746a66351bd/4ed177ce-8642-4533-a539-2746a66351bd.jsonl",
    }
    normalizeAgentHookPayload(payload)
    expect(payload.session_id).toBe("4ed177ce-8642-4533-a539-2746a66351bd")
    expect(payload.cwd).toBe("/Users/matthewherod/Development/swiz")
    expect(payload.tool_name).toBe("Bash")
    expect((payload.tool_input as { command: string }).command).toBe(
      "cd /Users/matthewherod/Development/swiz && bun run typecheck 2>&1"
    )
  })

  it("does not set Bash when tool_name is already present", () => {
    const payload: Record<string, unknown> = {
      tool_name: "mcp__x__y",
      command: "echo hi",
      workspace_roots: ["/proj"],
    }
    normalizeAgentHookPayload(payload)
    expect(payload.tool_name).toBe("mcp__x__y")
    expect(payload.tool_input).toBeUndefined()
  })

  it("adds sandbox to tool_input when Cursor sends sandbox: true", () => {
    const payload: Record<string, unknown> = {
      command: "npm test",
      cwd: "",
      workspace_roots: ["/repo"],
      sandbox: true,
    }
    normalizeAgentHookPayload(payload)
    expect((payload.tool_input as { sandbox?: boolean }).sandbox).toBe(true)
  })
})
