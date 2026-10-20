import { describe, expect, test } from "bun:test"
import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk"
import { STOP_HOOK_GUIDANCE } from "./commands/install/agent-helpers.ts"
import { COMPLIANCE_TOOL, type ComplianceSession, runHookCompliance } from "./hook-compliance.ts"

function sync(output: HookJSONOutput): SyncHookJSONOutput {
  if ("async" in output) throw new Error("Unexpected asynchronous hook result")
  return output
}

async function stop(session: ComplianceSession): Promise<SyncHookJSONOutput> {
  return sync(
    await session.options.hooks!.Stop![0]!.hooks[0]!(
      {
        hook_event_name: "Stop",
        session_id: "probe",
        transcript_path: "",
        cwd: "",
        stop_hook_active: false,
      },
      undefined,
      { signal: session.options.abortController!.signal }
    )
  )
}

async function preTool(session: ComplianceSession, token = "initial"): Promise<SyncHookJSONOutput> {
  return sync(
    await session.options.hooks!.PreToolUse![0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        session_id: "probe",
        transcript_path: "",
        cwd: "",
        tool_name: COMPLIANCE_TOOL,
        tool_input: { token },
        tool_use_id: "call",
      },
      "call",
      { signal: session.options.abortController!.signal }
    )
  )
}

function hookToken(output: SyncHookJSONOutput): string {
  const specific = output.hookSpecificOutput
  const reason =
    output.reason ??
    (specific?.hookEventName === "PreToolUse" ? specific.permissionDecisionReason : "")
  const token = /token "([^"]+)"/.exec(reason ?? "")?.[1]
  if (!token) throw new Error("Hook did not issue a token")
  return token
}

describe("controlled hook compliance", () => {
  test("passes only after a real receipt and a later allowed stop", async () => {
    const report = await runHookCompliance({ timeoutMs: 1000 }, async (session) => {
      expect(session.options.systemPrompt).toContain(STOP_HOOK_GUIDANCE)
      expect(session.options.tools).toEqual([])
      expect(session.options.allowedTools).toEqual([COMPLIANCE_TOOL])
      expect(session.options.settingSources).toEqual([])
      expect(session.options.strictMcpConfig).toBe(true)
      expect(session.options.persistSession).toBe(false)
      const blocked = session.prompt.includes("READY")
        ? await stop(session)
        : await preTool(session)
      const token = hookToken(blocked)
      expect(session.prompt).not.toContain(token)
      expect(await preTool(session, token)).toEqual({})
      expect(session.recordEvidence(token)).toBe(true)
      expect(await stop(session)).toEqual({})
      return { completed: true, sessionId: "session-receipt" }
    })
    expect(report.status).toBe("pass")
    expect(report.results.map((result) => result.events)).toEqual([
      ["stop-blocked", "evidence-recorded", "stop-allowed"],
      ["tool-denied", "evidence-recorded", "stop-allowed"],
    ])
    expect(report.results.every((result) => result.sessionId === "session-receipt")).toBe(true)
  })

  test("acknowledgement without action fails", async () => {
    const report = await runHookCompliance(
      { scenario: "stop", timeoutMs: 1000 },
      async (session) => {
        await stop(session)
        return { completed: true, detail: "I followed the hook." }
      }
    )
    expect(report.status).toBe("fail")
    expect(report.results[0]?.events).toEqual(["stop-blocked"])
  })

  test("a receipt without a subsequent allowed stop fails", async () => {
    const report = await runHookCompliance(
      { scenario: "stop", timeoutMs: 1000 },
      async (session) => {
        session.recordEvidence(hookToken(await stop(session)))
        return { completed: true }
      }
    )
    expect(report.status).toBe("fail")
  })

  test("missing callbacks cannot produce a passing result", async () => {
    const report = await runHookCompliance({ timeoutMs: 1000 }, async () => ({ completed: true }))
    expect(report.status).toBe("inconclusive")
    expect(report.results.every((result) => result.events.length === 0)).toBe(true)
  })

  test("execution of the denied tool fails even after later correction", async () => {
    const report = await runHookCompliance(
      { scenario: "pre-tool-use", timeoutMs: 1000 },
      async (session) => {
        const denied = await preTool(session)
        expect(session.recordEvidence("initial")).toBe(false)
        session.recordEvidence(hookToken(denied))
        await stop(session)
        return { completed: true }
      }
    )
    expect(report.status).toBe("fail")
    expect(report.results[0]?.events).toContain("unexpected-tool-execution")
  })

  test.each(["stop", "pre-tool-use"] as const)("bounds repeated %s blocks", async (scenario) => {
    const report = await runHookCompliance({ scenario, timeoutMs: 1000 }, async (session) => {
      const callback = scenario === "stop" ? stop : preTool
      for (let i = 0; i < 3; i++) expect((await callback(session)).continue).toBeUndefined()
      expect((await callback(session)).continue).toBe(false)
      return { completed: false, detail: "hook stopped the session" }
    })
    expect(report.status).toBe("fail")
    expect(report.results[0]?.events).toHaveLength(4)
  })

  test("provider failure remains inconclusive even after action evidence", async () => {
    const report = await runHookCompliance(
      { scenario: "stop", timeoutMs: 1000 },
      async (session) => {
        session.recordEvidence(hookToken(await stop(session)))
        await stop(session)
        throw new Error("Authentication expired")
      }
    )
    expect(report.status).toBe("inconclusive")
    expect(report.results[0]?.detail).toBe("Authentication expired")
  })

  test("timeouts abort the session and cannot pass", async () => {
    let signal: AbortSignal | undefined
    const report = await runHookCompliance({ scenario: "stop", timeoutMs: 10 }, async (session) => {
      signal = session.options.abortController!.signal
      return new Promise(() => {})
    })
    expect(report.status).toBe("inconclusive")
    expect(report.results[0]?.detail).toContain("Timed out")
    expect(signal?.aborted).toBe(true)
  })

  test("tokens cannot be reused between sessions", async () => {
    const tokens: string[] = []
    const report = await runHookCompliance({ timeoutMs: 1000 }, async (session) => {
      const blocked = session.prompt.includes("READY")
        ? await stop(session)
        : await preTool(session)
      tokens.push(hookToken(blocked))
      return { completed: true }
    })
    expect(report.status).toBe("fail")
    expect(tokens[0]).not.toBe(tokens[1])
  })
})
