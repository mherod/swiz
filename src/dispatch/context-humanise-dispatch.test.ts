import { describe, expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getAgent } from "../agents.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { stripInternalDispatchFields } from "./dispatch-wire.ts"
import { executeDispatch } from "./execute.ts"
import { DISPATCH_ROUTES } from "./index.ts"

const temp = useTempDir("swiz-humanise-dispatch-")

async function dispatch({
  event = "sessionStart",
  agent = "claude",
  enabled = true,
  steerEnabled = false,
  daemon = true,
  output,
  hooks = true,
  lifecycleStopAdvisory,
}: {
  event?: string
  agent?: string
  enabled?: boolean
  steerEnabled?: boolean
  daemon?: boolean
  output?: Record<string, unknown>
  hooks?: boolean
  lifecycleStopAdvisory?: string
} = {}) {
  const home = await temp.create()
  await mkdir(join(home, ".swiz"), { recursive: true })
  await Bun.write(
    join(home, ".swiz/settings.json"),
    JSON.stringify({
      humaniseHookContext: enabled,
      humaniseAutoSteer: steerEnabled,
      autoSteer: false,
      autoContinue: true,
    })
  )
  await Bun.write(join(home, ".swiz/state.json"), JSON.stringify({ state: "developing" }))
  const rewrite = mock(async (text: string) => `Natural: ${text}`)
  const hookOutput =
    output ??
    (event === "stop" || event === "subagentStop"
      ? { decision: "block", reason: "Raw context.", resolution: "human-required" }
      : { hookSpecificOutput: { additionalContext: "Raw context." } })
  const result = await executeDispatch({
    canonicalEvent: event,
    hookEventName: getAgent("claude")!.eventMap[event] ?? event,
    payloadStr: JSON.stringify({
      cwd: home,
      session_id: `humanise-${crypto.randomUUID()}`,
      tool_name: "Bash",
      tool_input: { command: "echo probe" },
      _agent: agent,
      // A recent user message must not suppress the independent context setting.
      _lastUserMessageAt: Date.now(),
      // Incoming callers cannot override the trusted global setting.
      _effectiveSettings: { humaniseHookContext: !enabled },
    }),
    daemonContext: daemon,
    settingsHomeOverride: home,
    hookContextRewriter: rewrite,
    lifecycleStopAdvisory,
    lastUserMessageAtProvider: () => Date.now(),
    manifestProvider: async () =>
      hooks
        ? [{ event, hooks: [{ hook: { name: "humanise-probe", event, run: () => hookOutput } }] }]
        : [],
    repositoryCapabilityProvider: async () => ({
      canonicalRoot: home,
      repoKey: home,
      isRepo: true,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    }),
    replayPendingMutations: async () => {},
    disableTranscriptSummaryFallback: true,
  })
  return { wire: stripInternalDispatchFields(result.response), rewrite }
}

describe("shared dispatch hook humanising", () => {
  test.each(Object.keys(DISPATCH_ROUTES))("humanises %s context", async (event) => {
    const { wire, rewrite } = await dispatch({ event })
    expect(rewrite).toHaveBeenCalled()
    const delivered = wire.systemMessage ?? wire.reason ?? wire.stopReason
    expect(delivered).toStartWith("Natural: ")
    expect(delivered).toContain("Raw context.")
  })

  test.each([
    "claude",
    "codex",
    "cursor",
    "gemini",
    "antigravity",
  ])("%s keeps its envelope after humanising", async (agent) => {
    const { wire } = await dispatch({ agent })
    expect(wire.systemMessage).toStartWith("Natural: ")
    expect(wire).not.toHaveProperty("decision")
    expect(wire.hookSpecificOutput ?? {}).not.toHaveProperty("contextsJoined")
    if (wire.hookSpecificOutput?.additionalContext) {
      expect(wire.hookSpecificOutput.additionalContext).toStartWith("Natural: ")
    }
  })

  test.each([false, true])("CLI/daemon=%s respects the independent setting", async (daemon) => {
    const disabled = await dispatch({ enabled: false, steerEnabled: true, daemon })
    expect(disabled.rewrite).not.toHaveBeenCalled()
    expect(disabled.wire.systemMessage).not.toContain("Natural: ")
    const enabled = await dispatch({ enabled: true, steerEnabled: false, daemon })
    expect(enabled.rewrite).toHaveBeenCalled()
    expect(enabled.wire.systemMessage).toStartWith("Natural: ")
  })

  test("humanises a denial without changing the permission decision", async () => {
    const { wire } = await dispatch({
      event: "preToolUse",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Obtain approval before proceeding.",
        },
      },
    })
    expect(wire.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(wire.hookSpecificOutput.permissionDecisionReason).toBe(
      "Natural: Obtain approval before proceeding."
    )
  })

  test("humanises generated context even when no hooks match", async () => {
    const { wire, rewrite } = await dispatch({ event: "preToolUse", hooks: false })
    expect(rewrite).toHaveBeenCalled()
    expect(wire.systemMessage).toStartWith("Natural: ")
    expect(wire.systemMessage).toContain("developing")
  })

  test("humanises daemon lifecycle advice before delivery", async () => {
    const advisory = "Task task-1: Compile assets is active (advisory only)."
    const { wire, rewrite } = await dispatch({
      event: "stop",
      hooks: false,
      lifecycleStopAdvisory: advisory,
    })
    expect(rewrite.mock.calls.some(([text]) => text.includes(advisory))).toBe(true)
    expect(wire.systemMessage).toStartWith("Natural: ")
    expect(wire.systemMessage).toContain(advisory)
    expect(wire.reason).toBe(`Natural: ${advisory}`)
    expect(wire.stopReason).toBe(wire.reason)
    expect(wire.continue).toBe(true)
  })
})
