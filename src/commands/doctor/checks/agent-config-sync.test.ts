import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentDef } from "../../../agents.ts"
import { manifest } from "../../../manifest.ts"
import { checkAgentConfigSync } from "./agent-config-sync.ts"

/** All canonical events the check actually expects (non-scheduled, non-empty-hooks). */
function expectedCanonicalEvents(): string[] {
  return [
    ...new Set(manifest.filter((g) => !g.scheduled && g.hooks.length > 0).map((g) => g.event)),
  ]
}

/** Build a settings.hooks object with one dispatch command per event. */
function buildHooks(events: string[]): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const event of events) {
    const agentEvent = event.charAt(0).toUpperCase() + event.slice(1)
    hooks[agentEvent] = [
      {
        hooks: [
          {
            type: "command",
            command: `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${event} ${agentEvent}`,
          },
        ],
      },
    ]
  }
  return hooks
}

function makeAgent(settingsPath: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "claude" as AgentDef["id"],
    name: "Test Agent",
    settingsPath,
    hooksKey: "hooks",
    configStyle: "nested",
    binary: "test-binary",
    toolAliases: {},
    eventMap: {},
    tasksEnabled: true,
    hooksConfigurable: true,
    ...overrides,
  } as AgentDef
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agent-config-sync-test-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("checkAgentConfigSync", () => {
  test("returns warn when settings file does not exist", async () => {
    await withTmpDir(async (dir) => {
      const agent = makeAgent(join(dir, "nonexistent.json"))
      const result = await checkAgentConfigSync(agent)
      expect(result.status).toBe("warn")
      expect(result.detail).toContain("not found")
    })
  })

  test("returns fail when settings file contains malformed JSON", async () => {
    await withTmpDir(async (dir) => {
      const settingsPath = join(dir, "settings.json")
      await writeFile(settingsPath, "not json at all")
      const result = await checkAgentConfigSync(makeAgent(settingsPath))
      expect(result.status).toBe("fail")
      expect(result.detail).toContain("malformed JSON")
    })
  })

  test("passes when all expected events are dispatched", async () => {
    await withTmpDir(async (dir) => {
      const events = expectedCanonicalEvents()
      const settingsPath = join(dir, "settings.json")
      await writeFile(settingsPath, JSON.stringify({ hooks: buildHooks(events) }))
      const result = await checkAgentConfigSync(makeAgent(settingsPath))
      expect(result.status).toBe("pass")
    })
  })

  test("empty-hooks manifest entries are not flagged as missing", async () => {
    await withTmpDir(async (dir) => {
      const events = expectedCanonicalEvents()
      // Verify the empty-hooks events are excluded from what the check expects
      expect(events).not.toContain("subagentStart")
      expect(events).not.toContain("subagentStop")
      expect(events).not.toContain("sessionEnd")

      const settingsPath = join(dir, "settings.json")
      await writeFile(settingsPath, JSON.stringify({ hooks: buildHooks(events) }))
      const result = await checkAgentConfigSync(makeAgent(settingsPath))
      expect(result.status).toBe("pass")
      expect(result.detail).not.toContain("subagentStart")
      expect(result.detail).not.toContain("subagentStop")
      expect(result.detail).not.toContain("sessionEnd")
    })
  })

  test("unsupportedEvents are not flagged as missing for the agent", async () => {
    await withTmpDir(async (dir) => {
      const unsupportedEvents = ["preCompact", "notification"]
      const events = expectedCanonicalEvents().filter((e) => !unsupportedEvents.includes(e))
      const settingsPath = join(dir, "settings.json")
      await writeFile(settingsPath, JSON.stringify({ hooks: buildHooks(events) }))
      const result = await checkAgentConfigSync(makeAgent(settingsPath, { unsupportedEvents }))
      expect(result.status).toBe("pass")
      expect(result.detail).not.toContain("preCompact")
      expect(result.detail).not.toContain("notification")
    })
  })

  test("warns listing only missing required events, not unsupportedEvents", async () => {
    await withTmpDir(async (dir) => {
      const unsupportedEvents = ["preCompact"]
      const events = expectedCanonicalEvents()
        .filter((e) => !unsupportedEvents.includes(e))
        .filter((e) => e !== "stop")
      const settingsPath = join(dir, "settings.json")
      await writeFile(settingsPath, JSON.stringify({ hooks: buildHooks(events) }))
      const result = await checkAgentConfigSync(makeAgent(settingsPath, { unsupportedEvents }))
      expect(result.status).toBe("warn")
      expect(result.detail).toContain("stop")
      expect(result.detail).not.toContain("preCompact")
    })
  })
})
