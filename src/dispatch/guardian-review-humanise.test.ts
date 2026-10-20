import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import pretooluseGuardianAwareness from "../../hooks/pretooluse-guardian-awareness.ts"
import { parseTranscriptSummary } from "../transcript-summary.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { stripInternalDispatchFields } from "./dispatch-wire.ts"
import { executeDispatch } from "./execute.ts"

const temp = useTempDir("swiz-guardian-humanise-")
const command = "git add -- index.ts src/hook-compliance.ts"

function call(callId: string, escalated: boolean): string {
  const input = { cmd: command, ...(escalated && { sandbox_permissions: "require_escalated" }) }
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "functions.exec",
      call_id: callId,
      input: `text(await tools.exec_command(${JSON.stringify(input)}));`,
    },
  })
}

function result(callId: string, text: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: callId, output: text },
  })
}

test("humanised git add denials advance to approval review after three retries", async () => {
  const home = await temp.create()
  await mkdir(join(home, ".swiz"), { recursive: true })
  await Bun.write(
    join(home, ".swiz/settings.json"),
    JSON.stringify({ humaniseHookContext: true, autoSteer: false, autoContinue: false })
  )
  const lines = [
    call("sandbox", false),
    result("sandbox", "fatal: Unable to create '/repo/.git/index.lock': Operation not permitted"),
  ]

  for (let attempt = 1; attempt <= 4; attempt++) {
    const callId = `retry-${attempt}`
    lines.push(call(callId, true))
    const { response } = await executeDispatch({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: home,
        session_id: "guardian-humanise-test",
        transcript_path: "/virtual/codex.jsonl",
        tool_name: "Bash",
        tool_input: { command },
        _agent: "codex",
      }),
      daemonContext: true,
      settingsHomeOverride: home,
      hookContextRewriter: async (text) =>
        text.replace(
          "Guardian review avoided: this `git add` retry only needs escalation",
          "Guardian review was avoided because this `git add` retry needs escalation only"
        ),
      manifestProvider: async () => [
        { event: "preToolUse", matcher: "Bash", hooks: [{ hook: pretooluseGuardianAwareness }] },
      ],
      transcriptSummaryProvider: async () => parseTranscriptSummary(lines.join("\n")),
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: home,
        repoKey: home,
        isRepo: true,
        repoSlug: null,
        hasGhCli: false,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    })
    const wire = stripInternalDispatchFields(response)
    const specific = wire.hookSpecificOutput
    if (attempt <= 3) {
      expect(specific?.permissionDecision).toBe("deny")
      const reason = String(specific?.permissionDecisionReason)
      expect(reason).toStartWith("Guardian review was avoided because")
      expect(reason).toContain(`Guardian denial ${attempt} of at most 3`)
      lines.push(result(callId, `Script error:\nCommand blocked by PreToolUse hook: ${reason}`))
    } else {
      expect(wire.decision).toBeUndefined()
      expect(specific?.permissionDecision).toBeUndefined()
      expect(wire.systemMessage).toContain("retry allowance reached")
      expect(wire.systemMessage).toContain("does not override a denied approval")
    }
  }
})
