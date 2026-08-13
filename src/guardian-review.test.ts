import { describe, expect, test } from "bun:test"
import { evaluateGuardianAwareness } from "../hooks/pretooluse-guardian-awareness.ts"
import {
  detectGuardianReviewRequest,
  enrichPayloadWithGuardianReview,
  GIT_ADD_GUARDIAN_DENIAL_MARKER,
} from "./guardian-review.ts"
import type { JsonLike } from "./schemas.ts"
import { getHookSpecificOutput } from "./utils/hook-specific-output.ts"

const COMMAND = "SWIZ_DIRECT=1 bun run index.ts push-wait origin main"
const GIT_ADD_COMMAND = "git add -- hooks/shim.sh src/commands/shim.test.ts"

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

function wrapperResult(callId: string, output: JsonLike, timestamp?: string): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output,
    },
  })
}

function wrapperOutput(callId: string, text: string | string[], timestamp?: string): string {
  const blocks = Array.isArray(text) ? text : [text]
  return wrapperResult(
    callId,
    blocks.map((block) => ({ type: "input_text", text: block })),
    timestamp
  )
}

function guardianDeniedOutput(callId: string, timestamp: string): string {
  return wrapperOutput(
    callId,
    [
      "Script failed\nWall time: 0.3 seconds\nOutput:\n",
      `Script error:\nCommand blocked by PreToolUse hook: ${GIT_ADD_GUARDIAN_DENIAL_MARKER} only needs escalation because the sandbox cannot write Git's index lock.`,
    ],
    timestamp
  )
}

function multiCommandWrapperCall(
  callId: string,
  commands: Array<{ command: string; escalated?: boolean }>
): string {
  const calls = commands
    .map(({ command, escalated }) => {
      const sandbox = escalated ? ',sandbox_permissions:"require_escalated"' : ""
      return `tools.exec_command({cmd:${JSON.stringify(command)}${sandbox}})`
    })
    .join(",")
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: `const results = await Promise.all([${calls}]); results.forEach(text)`,
    },
  })
}

describe("guardian review transcript detection", () => {
  test("detects a proactive Codex escalation before a sandboxed attempt", () => {
    expect(detectGuardianReviewRequest([wrapperCall("current", COMMAND, true)], COMMAND)).toEqual({
      requested: true,
      source: "codex-transcript",
      priorSandboxAttempt: "not-attempted",
      recentGitAddGuardianDenialCount: 0,
    })
  })

  test("counts only git add guardian denials from the last minute", () => {
    const nowMs = Date.parse("2026-08-11T12:01:00.000Z")
    const lines = [
      guardianDeniedOutput("old", "2026-08-11T11:59:59.000Z"),
      guardianDeniedOutput("recent-a", "2026-08-11T12:00:10.000Z"),
      guardianDeniedOutput("recent-b", "2026-08-11T12:00:30.000Z"),
      wrapperOutput(
        "quoted",
        `Search output mentioning ${GIT_ADD_GUARDIAN_DENIAL_MARKER} without being a denied tool call.`,
        "2026-08-11T12:00:40.000Z"
      ),
      wrapperCall("current", GIT_ADD_COMMAND, true),
    ]

    expect(
      detectGuardianReviewRequest(lines, GIT_ADD_COMMAND, nowMs)?.recentGitAddGuardianDenialCount
    ).toBe(2)
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
      wrapperOutput("prior", [
        "Script completed\nOutput:\n",
        "fatal: cannot create lock file: Operation not permitted\n",
        "exit=1",
      ]),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe(
      "permission-failed"
    )
  })

  test("recognizes a doubly encoded structured sandbox failure", () => {
    const encodedResult = JSON.stringify(
      JSON.stringify({ exit_code: 1, output: "Operation not permitted" })
    )
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput("prior", encodedResult),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe(
      "permission-failed"
    )
  })

  test("classifies typed and encoded structured sandbox failures identically", () => {
    const typedLines = [
      wrapperCall("prior", COMMAND, false),
      wrapperResult("prior", { exit_code: 1, output: "Operation not permitted" }),
      wrapperCall("current", COMMAND, true),
    ]
    const encodedLines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput(
        "prior",
        JSON.stringify(JSON.stringify({ exit_code: 1, output: "Operation not permitted" }))
      ),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(typedLines, COMMAND)?.priorSandboxAttempt).toBe(
      detectGuardianReviewRequest(encodedLines, COMMAND)?.priorSandboxAttempt
    )
  })

  test("recognizes explicit EPERM and EACCES failures", () => {
    for (const output of [
      "EPERM: operation not permitted, mkdir '/restricted'",
      "Error: EACCES, permission denied '/restricted'",
    ]) {
      const lines = [
        wrapperCall("prior", COMMAND, false),
        wrapperOutput("prior", output),
        wrapperCall("current", COMMAND, true),
      ]

      expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe(
        "permission-failed"
      )
    }
  })

  test("recognizes an output-only Git permission failure", () => {
    const lines = [
      wrapperCall("prior", GIT_ADD_COMMAND, false),
      wrapperOutput(
        "prior",
        "Script completed\nWall time: 0.5 seconds\nOutput:\nfatal: Unable to create '/repo/.git/index.lock': Operation not permitted\n"
      ),
      wrapperCall("current", GIT_ADD_COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, GIT_ADD_COMMAND)?.priorSandboxAttempt).toBe(
      "permission-failed"
    )
  })

  test("does not transfer a compound command permission failure to one contained command", () => {
    const containedCommand = "git status --short"
    const compoundCommand = `${containedCommand} && touch ~/.swiz-guardian-test`
    const lines = [
      wrapperCall("prior", compoundCommand, false),
      wrapperOutput("prior", "touch: Operation not permitted\nexit=1"),
      wrapperCall("current", containedCommand, true),
    ]

    expect(detectGuardianReviewRequest(lines, containedCommand)?.priorSandboxAttempt).toBe(
      "not-attempted"
    )
  })

  test("does not transfer an ambiguous parallel wrapper failure to one command", () => {
    const lines = [
      multiCommandWrapperCall("prior", [
        { command: COMMAND },
        { command: "touch ~/.swiz-guardian-test" },
      ]),
      wrapperOutput("prior", "touch: Operation not permitted\nexit=1"),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe("not-attempted")
  })

  test("does not treat permission wording in successful output as a sandbox failure", () => {
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput(
        "prior",
        "Script completed\nOutput:\nOperation not permitted is documented here"
      ),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe("unknown")
  })

  test("keeps explicit success ahead of incidental OS permission error codes", () => {
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput("prior", "EPERM: documented platform behavior\nexit=0"),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe("succeeded")
  })

  test("does not treat OS permission error names in documentation as a failure", () => {
    const lines = [
      wrapperCall("prior", COMMAND, false),
      wrapperOutput("prior", "Documentation lists EPERM, EACCES, and ENOENT error names."),
      wrapperCall("current", COMMAND, true),
    ]

    expect(detectGuardianReviewRequest(lines, COMMAND)?.priorSandboxAttempt).toBe("unknown")
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

  test("allows the hook decision after a doubly encoded sandbox failure", () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: COMMAND },
    }
    const encodedResult = JSON.stringify(
      JSON.stringify({ exit_code: 1, output: "Operation not permitted" })
    )
    enrichPayloadWithGuardianReview(payload, {
      sessionLines: [
        wrapperCall("prior", COMMAND, false),
        wrapperOutput("prior", encodedResult),
        wrapperCall("current", COMMAND, true),
      ],
    })

    const specific = getHookSpecificOutput(evaluateGuardianAwareness(payload))
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.additionalContext).toContain("narrowly scoped")
  })
})
