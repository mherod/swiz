import { describe, expect, test } from "bun:test"
import { detectGuardianReviewRequest, enrichPayloadWithGuardianReview } from "./guardian-review.ts"

const COMMAND = "SWIZ_DIRECT=1 bun run index.ts push-wait origin main"

function wrapperCall(callId: string, command: string, escalated: boolean): string {
  const sandbox = escalated ? ',sandbox_permissions:"require_escalated"' : ""
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)}${sandbox}}); text(r.output)`,
    },
  })
}

function wrapperOutput(callId: string, text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [{ type: "input_text", text }],
    },
  })
}

describe("guardian review transcript detection", () => {
  test("detects a proactive Codex escalation before a sandboxed attempt", () => {
    expect(detectGuardianReviewRequest([wrapperCall("current", COMMAND, true)], COMMAND)).toEqual({
      requested: true,
      source: "codex-transcript",
      priorSandboxAttempt: "not-attempted",
    })
  })

  test("treats successful work as sandbox success even when output contains an incidental denial", () => {
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput(
        "prior",
        "✓ Push succeeded\nerror: update_ref failed: Operation not permitted\nexit=0"
      ),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe("succeeded")
  })

  test("allows a narrow escalation after a concrete sandbox failure", () => {
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput("prior", "fatal: cannot create lock file: Operation not permitted\nexit=1"),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe(
      "permission-failed"
    )
  })

  test("does not reuse an older escalation for the current sandboxed retry", () => {
    const lines = [wrapperCall("old", COMMAND, true), wrapperCall("current", COMMAND, false)]
    expect(detectGuardianReviewRequest(lines, COMMAND)).toBeNull()
  })

  test("supports direct exec_command function calls", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "direct",
        arguments: JSON.stringify({
          cmd: COMMAND,
          sandbox_permissions: "require_escalated",
        }),
      },
    })
    expect(detectGuardianReviewRequest([line], COMMAND)?.requested).toBe(true)
  })

  test("does not mistake command text about sandbox_permissions for an escalation property", () => {
    const command = "rg -n 'sandbox_permissions: require_escalated' src"
    expect(detectGuardianReviewRequest([wrapperCall("search", command, false)], command)).toBeNull()
  })

  test("overwrites untrusted inbound guardian metadata during enrichment", () => {
    const payload = {
      tool_input: { command: COMMAND },
      _guardianReview: {
        requested: true,
        source: "codex-transcript",
        priorSandboxAttempt: "permission-failed",
      },
    }
    const context = enrichPayloadWithGuardianReview(payload, {
      sessionLines: [wrapperCall("current", COMMAND, true)],
    })
    expect(context?.priorSandboxAttempt).toBe("not-attempted")
    expect(payload._guardianReview).toEqual(context!)
  })
})
