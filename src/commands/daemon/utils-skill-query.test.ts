import { describe, expect, it } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { getRecentSkillsUsedForCurrentSession } from "../../transcript-summary.ts"
import {
  buildSessionToolUsageStateFromCapturedCalls,
  type CapturedToolCall,
  captureSessionToolCall,
  captureSessionToolUsage,
  persistSessionToolCall,
  readPersistedSessionToolCalls,
  type SessionToolUsageState,
} from "./utils.ts"

const NOW = Date.parse("2026-09-11T12:00:00Z")
const TOOL = "mcp__swiz__SkillQuery"

describe("SkillQuery daemon usage", () => {
  it.each([
    { name: TOOL, input: { name: "commit" } },
    {
      name: "functions.exec",
      input: { code: 'await tools.mcp__swiz__SkillQuery({name:"commit"})' },
    },
  ])("includes content reads in live and recovered recency: %j", async ({ name, input }) => {
    const state = captureSessionToolUsage(
      new Map<string, SessionToolUsageState>(),
      "session",
      name,
      input,
      NOW
    )
    const captured = new Map<string, CapturedToolCall[]>()
    captureSessionToolCall(captured, "session", name, input, NOW)
    const recovered = buildSessionToolUsageStateFromCapturedCalls(captured.get("session")!, NOW)
    for (const usage of [state, recovered]) {
      expect(usage.skillInvocations).toEqual(["commit"])
      expect(
        await getRecentSkillsUsedForCurrentSession(
          { _currentSessionToolUsage: usage },
          { nowMs: NOW }
        )
      ).toEqual(["commit"])
      expect(
        await getRecentSkillsUsedForCurrentSession(
          { _currentSessionToolUsage: usage },
          { nowMs: NOW + 21 * 60_000 }
        )
      ).toEqual([])
    }
  })

  it.each([
    {},
    { query: "commit" },
    { action: "lookup", name: "commit" },
  ])("excludes browsing from live and captured usage %j", (input) => {
    const usage = captureSessionToolUsage(new Map(), "session", TOOL, input, NOW)
    const captured = new Map<string, CapturedToolCall[]>()
    captureSessionToolCall(captured, "session", TOOL, input, NOW)
    expect(usage.skillInvocations).toEqual([])
    expect(
      buildSessionToolUsageStateFromCapturedCalls(captured.get("session")!, NOW).skillInvocations
    ).toEqual([])
  })

  it("persists read evidence beyond truncated exec display text", async () => {
    const home = join(TMP_ROOT, `swiz-skill-query-${crypto.randomUUID()}`)
    const cwd = join(home, "project")
    const code = `${" ".repeat(2100)}await tools.mcp__swiz__SkillQuery({name:"commit"});`
    try {
      await persistSessionToolCall(cwd, "session", "exec", { code }, NOW, home)
      const calls = await readPersistedSessionToolCalls(cwd, "session", 10, home)
      expect(calls[0]?.detail).not.toContain("commit")
      expect(calls[0]?.skillInvocations).toEqual(["commit"])
      expect(buildSessionToolUsageStateFromCapturedCalls(calls, NOW).skillInvocations).toEqual([
        "commit",
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("still hydrates older native Skill records without additional metadata", () => {
    const calls = [{ name: "Skill", detail: "commit fix", timestamp: new Date(NOW).toISOString() }]
    expect(buildSessionToolUsageStateFromCapturedCalls(calls, NOW).skillInvocations).toEqual([
      "commit",
    ])
  })
})
