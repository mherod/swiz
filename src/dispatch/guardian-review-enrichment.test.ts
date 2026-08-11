import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pretooluseGuardianAwareness from "../../hooks/pretooluse-guardian-awareness.ts"
import { parseTranscriptSummary } from "../transcript-summary.ts"
import { getHookSpecificOutput } from "../utils/hook-specific-output.ts"
import { executeDispatch } from "./execute.ts"

const COMMAND = "git push origin main"

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
})
