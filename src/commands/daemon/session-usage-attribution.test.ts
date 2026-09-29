import { describe, expect, test } from "bun:test"
import readStallGuard from "../../../hooks/pretooluse-read-grep-stall-guard.ts"
import { sessionUsageKey } from "../../dispatch/session-usage-key.ts"
import { captureSessionToolUsage, type SessionToolUsageState } from "./utils.ts"

/** #962: a subagent's tool calls must not land in the parent session's usage stream. */
const SESSION = "parent-session"

function record(
  usage: Map<string, SessionToolUsageState>,
  count: number,
  toolName: string,
  agentId?: string
): void {
  for (let i = 0; i < count; i++) {
    captureSessionToolUsage(
      usage,
      sessionUsageKey(SESSION, agentId),
      toolName,
      { file_path: `/repo/file-${i}.ts` },
      Date.now()
    )
  }
}

async function guard(usage: Map<string, SessionToolUsageState>, agentId?: string) {
  const state = usage.get(sessionUsageKey(SESSION, agentId))
  return readStallGuard.run({
    session_id: SESSION,
    tool_name: "Read",
    tool_input: { file_path: "/repo/next.ts" },
    _currentSessionToolUsage: { toolNames: state?.toolNames ?? [], skillInvocations: [] },
  } as never)
}

function isDenied(output: unknown): boolean {
  return JSON.stringify(output).includes('"deny"')
}

describe("session tool usage attribution (#962)", () => {
  test("a subagent's Reads do not count toward the parent's stall streak", async () => {
    const usage = new Map<string, SessionToolUsageState>()
    record(usage, 2, "Edit")
    record(usage, 2, "Read")
    record(usage, 35, "Read", "explore-1")
    expect(isDenied(await guard(usage))).toBe(false)
  })

  test("control: a parent with 30 Reads of its own is still blocked", async () => {
    const usage = new Map<string, SessionToolUsageState>()
    record(usage, 30, "Read")
    expect(isDenied(await guard(usage))).toBe(true)
  })

  test("a subagent stalling within its own calls is detected against its agent id", async () => {
    const usage = new Map<string, SessionToolUsageState>()
    record(usage, 30, "Read", "explore-1")
    expect(isDenied(await guard(usage, "explore-1"))).toBe(true)
    expect(isDenied(await guard(usage, "explore-2"))).toBe(false)
  })

  test("usage keys keep the parent key unchanged and separate each subagent", () => {
    expect(sessionUsageKey(SESSION)).toBe(SESSION)
    expect(sessionUsageKey(SESSION, null)).toBe(SESSION)
    expect(sessionUsageKey(SESSION, "a")).not.toBe(sessionUsageKey(SESSION, "b"))
  })
})
