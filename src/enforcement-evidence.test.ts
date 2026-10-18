import { describe, expect, test } from "bun:test"
import {
  buildBrowserPolicyFixture,
  buildEnforcementReport,
  type CapturedEvent,
  replayBrowserPolicy,
} from "./enforcement-evidence.ts"
import type { HookLogEntry } from "./hook-log.ts"

const now = Date.parse("2026-10-18T01:00:00Z")
function capture(overrides: Record<string, unknown> = {}, age = 0): CapturedEvent {
  return {
    file: "capture.json",
    capture: {
      _swizIncomingCapture: {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        parseError: false,
        capturedAt: new Date(now - age).toISOString(),
      },
      incoming: {
        session_id: "session-a",
        cwd: "/project",
        _agent: "codex",
        tool_name: "Bash",
        tool_input: { command: "false && playwriter skill" },
        _swizDispatchId: "dispatch-a",
        ...overrides,
      },
    },
  }
}
function log(overrides: Partial<HookLogEntry> = {}): HookLogEntry {
  return {
    ts: new Date(now).toISOString(),
    event: "preToolUse",
    hookEventName: "PreToolUse",
    hook: "pretooluse-banned-commands.ts",
    status: "deny",
    durationMs: 1,
    exitCode: 0,
    sessionId: "session-a",
    dispatchId: "dispatch-a",
    ...overrides,
  }
}

describe("enforcement evidence", () => {
  test("correlates a denial without claiming host acceptance", () => {
    const report = buildEnforcementReport([capture()], [log()], { now })
    expect(report.observations[0]?.outcome).toBe("denied")
    expect(report.hostAcceptance).toBe("unverified")
    expect(report.sessions[0]).toMatchObject({
      denied: 1,
      agent: "codex",
      resolvedShellObserved: true,
      evidence: "recent",
    })
  })
  test.each(
    [
      [],
      [log({ sessionId: "other" })],
      [log({ dispatchId: "other" })],
      [log({ event: "postToolUse" })],
      [log({ status: "skipped" })],
      [log({ hook: "dispatch", kind: "dispatch", status: "ok" })],
    ].map((logs) => ({ logs }))
  )("does not invent a decision from missing or mismatched logs", ({ logs }) => {
    expect(buildEnforcementReport([capture()], logs, { now }).observations[0]?.outcome).toBe(
      "unknown"
    )
  })
  test("requires successful hooks and completed dispatch before calling it passed", () => {
    const hooks = [log({ status: "ok" }), log({ hook: "dispatch", kind: "dispatch", status: "ok" })]
    expect(buildEnforcementReport([capture()], hooks, { now }).observations[0]?.outcome).toBe(
      "passed"
    )
    hooks[0] = log({ status: "timeout" })
    expect(buildEnforcementReport([capture()], hooks, { now }).observations[0]?.outcome).toBe(
      "unknown"
    )
  })
  test("keeps project, session, time window and stale evidence distinct", () => {
    const captures = [
      capture({}, 6 * 60_000),
      capture({ session_id: "other" }),
      capture({ cwd: "/elsewhere" }),
      capture({}, 21 * 60_000),
      capture({}, -1000),
    ]
    const report = buildEnforcementReport(captures, [], {
      now,
      cwd: "/project",
      sessionId: "session-a",
    })
    expect(report.observations).toHaveLength(1)
    expect(report.sessions[0]?.evidence).toBe("stale")
    expect(buildEnforcementReport([], [], { now }).state).toBe("no-event-observed")
  })
  test("applies normalization deltas and ignores parse errors", () => {
    const entry = capture({ _swizDispatchId: undefined })
    entry.capture.normalizationDelta = { set: { _swizDispatchId: "dispatch-a" }, removed: [] }
    expect(buildEnforcementReport([entry], [log()], { now }).observations[0]?.outcome).toBe(
      "denied"
    )
    entry.capture._swizIncomingCapture.parseError = true
    expect(buildEnforcementReport([entry], [log()], { now }).observations).toEqual([])
  })
})

describe("browser policy fixtures", () => {
  test("exports minimal redacted input without session, environment or output", () => {
    const secret = ["g", "h", "p", "_", "abcdefghijklmnopqrstuv"].join("")
    const fixture = buildBrowserPolicyFixture({
      ...capture().capture.incoming,
      _env: { PASSWORD: "private" },
      transcript_path: "/private/transcript",
      tool_response: "private",
      tool_input: {
        command: `echo --token ${secret} --password 'private value' https://user:pass@example.com`,
        extra: "private",
      },
    })
    const text = JSON.stringify(fixture)
    expect(text).not.toContain(secret)
    expect(text).not.toContain("private value")
    expect(text).not.toContain("user:pass")
    expect(fixture.payload).not.toHaveProperty("session_id")
    expect(fixture.payload).not.toHaveProperty("_env")
    expect(fixture.payload).not.toHaveProperty("tool_response")
    expect(fixture.redacted).toBe(true)
  })
  test.each([
    "Bash",
    "exec_command",
    "functions.exec_command",
  ])("denies a resolved computed command via %s without execution", async (tool) => {
    const executable = ["play", "writer"].join("")
    const command = `false && npx --offline --yes ${executable}@latest skill`
    expect(await replayBrowserPolicy({ tool_name: tool, tool_input: { command } })).toMatchObject({
      decision: "deny",
      coverage: "resolved-shell-command",
      executed: false,
    })
  })
  test("does not evaluate dynamic JavaScript or treat it as an allow", async () => {
    expect(
      await replayBrowserPolicy({
        tool_name: "exec",
        tool_input: { code: "const cmd = getCommand(); await tools.exec_command({cmd});" },
      })
    ).toMatchObject({ decision: "unresolved", coverage: "literal-commands-only", executed: false })
  })
  test("replays quoted browser callbacks from an exported fixture", async () => {
    const cmd = "false && playwriter -e 'console.log(await page.evaluate(()=>({a:1})));'"
    const fixture = buildBrowserPolicyFixture({
      tool_name: "exec",
      tool_input: { input: `await tools.exec_command({cmd:${JSON.stringify(cmd)}});` },
    })
    expect(await replayBrowserPolicy(fixture)).toMatchObject({
      decision: "deny",
      commandCount: 1,
      executed: false,
    })
  })
  test("allows benign mentions without asserting permission from other policies", async () => {
    expect(
      await replayBrowserPolicy({ tool_name: "Bash", tool_input: { command: "echo playwriter" } })
    ).toMatchObject({ decision: "no-match", executed: false })
  })
})
