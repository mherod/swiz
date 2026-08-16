import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pretooluseGuardianAwareness from "../../hooks/pretooluse-guardian-awareness.ts"
import { GIT_ADD_GUARDIAN_DENIAL_MARKER } from "../guardian-review.ts"
import { parseTranscriptSummary } from "../transcript-summary.ts"
import { getHookSpecificOutput } from "../utils/hook-specific-output.ts"
import { executeDispatch } from "./execute.ts"

const COMMAND = "git push origin main"
const GIT_ADD_COMMAND = "git add -- hooks/shim.sh src/commands/shim.test.ts"

describe("guardian review dispatch enrichment", () => {
  const tempDirs: string[] = []

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("blocks a proactive escalation through the real dispatch pipeline", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-guardian-project-"))
    const settingsHome = await mkdtemp(join(tmpdir(), "swiz-guardian-home-"))
    tempDirs.push(projectDir, settingsHome)

    const transcriptLine = JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "guardian-dispatch-call",
        input:
          'const r = await tools.exec_command({cmd:"git push origin main",sandbox_permissions:"require_escalated"}); text(r.output)',
      },
    })

    const request = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: projectDir,
        session_id: "guardian-dispatch-test",
        transcript_path: "/virtual/codex.jsonl",
        tool_name: "Bash",
        tool_input: { command: COMMAND },
      }),
      daemonContext: true,
      settingsHomeOverride: settingsHome,
      manifestProvider: async () => [
        {
          event: "preToolUse",
          matcher: "Bash",
          hooks: [{ hook: pretooluseGuardianAwareness }],
        },
      ],
      transcriptSummaryProvider: async () => parseTranscriptSummary(transcriptLine),
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: projectDir,
        repoKey: "guardian-dispatch-test",
        isRepo: true,
        repoSlug: null,
        hasGhCli: true,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    } as const

    const first = await executeDispatch(request)
    const second = await executeDispatch(request)

    for (const { response } of [first, second]) {
      const specific = getHookSpecificOutput(response)
      expect(specific?.permissionDecision).toBe("deny")
      expect(specific?.permissionDecisionReason).toContain("has not been attempted")
    }
  })

  test("steers git add away from escalation after an output-only permission failure", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-guardian-project-"))
    const settingsHome = await mkdtemp(join(tmpdir(), "swiz-guardian-home-"))
    tempDirs.push(projectDir, settingsHome)

    const transcriptLines = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "guardian-prior-call",
          input: `const r = await tools.exec_command({cmd:${JSON.stringify(GIT_ADD_COMMAND)}}); text(r.output)`,
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "guardian-prior-call",
          output: [
            {
              type: "input_text",
              text: "Script completed\nOutput:\nfatal: Unable to create '/repo/.git/index.lock': Operation not permitted\n",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "guardian-current-call",
          input: `const r = await tools.exec_command({cmd:${JSON.stringify(GIT_ADD_COMMAND)},sandbox_permissions:"require_escalated"}); text(r.output)`,
        },
      }),
    ].join("\n")

    const request = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: projectDir,
        session_id: "guardian-dispatch-permission-test",
        transcript_path: "/virtual/codex.jsonl",
        tool_name: "Bash",
        tool_input: { command: GIT_ADD_COMMAND },
        _env: { CODEX_THREAD_ID: "guardian-dispatch-permission-test" },
      }),
      daemonContext: true,
      settingsHomeOverride: settingsHome,
      manifestProvider: async () => [
        {
          event: "preToolUse",
          matcher: "Bash",
          hooks: [{ hook: pretooluseGuardianAwareness }],
        },
      ],
      transcriptSummaryProvider: async () => parseTranscriptSummary(transcriptLines),
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: projectDir,
        repoKey: "guardian-dispatch-permission-test",
        isRepo: true,
        repoSlug: null,
        hasGhCli: true,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    } as const

    const { response } = await executeDispatch(request)
    const specific = getHookSpecificOutput(response)
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("Retry permitted by guard")
    expect(specific?.permissionDecisionReason).toContain("git commit -a")
  })

  test("lets git add reach approval after three recent guardian denials", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-guardian-project-"))
    const settingsHome = await mkdtemp(join(tmpdir(), "swiz-guardian-home-"))
    tempDirs.push(projectDir, settingsHome)
    const nowMs = Date.now()
    const timestamp = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString()
    const denialLines = [0, 1, 2].flatMap((index) => {
      const callId = `guardian-denied-${index}`
      const at = timestamp(-30_000 + index * 10_000)
      return [
        JSON.stringify({
          timestamp: at,
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: callId,
            input: `const r = await tools.exec_command({cmd:${JSON.stringify(GIT_ADD_COMMAND)},sandbox_permissions:"require_escalated"}); text(r.output)`,
          },
        }),
        JSON.stringify({
          timestamp: at,
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: callId,
            output: [
              { type: "input_text", text: "Script failed\nWall time: 0.3 seconds\nOutput:\n" },
              {
                type: "input_text",
                text: `Script error:\nCommand blocked by PreToolUse hook: ${GIT_ADD_GUARDIAN_DENIAL_MARKER} only needs escalation because the sandbox cannot write Git's index lock.`,
              },
            ],
          },
        }),
      ]
    })
    const transcriptLines = [
      JSON.stringify({
        timestamp: timestamp(-50_000),
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "guardian-prior-sandbox-call",
          input: `const r = await tools.exec_command({cmd:${JSON.stringify(GIT_ADD_COMMAND)}}); text(r.output)`,
        },
      }),
      JSON.stringify({
        timestamp: timestamp(-49_000),
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "guardian-prior-sandbox-call",
          output: [
            {
              type: "input_text",
              text: "Script failed\nOutput:\nfatal: Unable to create '/repo/.git/index.lock': Operation not permitted\n",
            },
          ],
        },
      }),
      ...denialLines,
      JSON.stringify({
        timestamp: timestamp(0),
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "guardian-current-call",
          input: `const r = await tools.exec_command({cmd:${JSON.stringify(GIT_ADD_COMMAND)},sandbox_permissions:"require_escalated"}); text(r.output)`,
        },
      }),
    ].join("\n")

    const request = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: projectDir,
        session_id: "guardian-dispatch-rate-limit-test",
        transcript_path: "/virtual/codex.jsonl",
        tool_name: "Bash",
        tool_input: { command: GIT_ADD_COMMAND },
        _env: { CODEX_THREAD_ID: "guardian-dispatch-rate-limit-test" },
      }),
      daemonContext: true,
      settingsHomeOverride: settingsHome,
      manifestProvider: async () => [
        {
          event: "preToolUse",
          matcher: "Bash",
          hooks: [{ hook: pretooluseGuardianAwareness }],
        },
      ],
      transcriptSummaryProvider: async () => parseTranscriptSummary(transcriptLines),
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: projectDir,
        repoKey: "guardian-dispatch-rate-limit-test",
        isRepo: true,
        repoSlug: null,
        hasGhCli: true,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    } as const

    const { response } = await executeDispatch(request)
    const specific = getHookSpecificOutput(response)
    expect(response.decision).toBeUndefined()
    expect(specific?.permissionDecision).toBeUndefined()
    expect(response.systemMessage).toContain("retry allowance reached")
    expect(response.systemMessage).toContain("retry is permitted")
  })
})
