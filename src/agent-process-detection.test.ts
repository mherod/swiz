import { describe, expect, test } from "bun:test"
import { detectCurrentAgent, resetParentProcessCommandCacheForTests } from "./agent-paths.ts"
import { AGENTS, getAgent } from "./agents.ts"

describe("parent process lookup", () => {
  test("runs ps once per process, however often the agent is detected", () => {
    // Detection only reaches the parent-process fallback when no agent variable is set,
    // which is always the case inside the daemon.
    const agentEnvVars = AGENTS.flatMap((agent) => agent.envVars ?? [])
    const savedEnv = new Map(agentEnvVars.map((name) => [name, process.env[name]]))
    for (const name of agentEnvVars) delete process.env[name]
    const originalSpawnSync = Bun.spawnSync
    let psCalls = 0
    // @ts-expect-error - counting stub
    Bun.spawnSync = (cmd: string[]) => {
      if (cmd[0] === "ps") psCalls++
      return { stdout: new TextEncoder().encode("/sbin/launchd\n"), exitCode: 0 }
    }
    resetParentProcessCommandCacheForTests()
    try {
      expect(detectCurrentAgent()).toBeNull()
      // Control: the fallback was reached and did spawn, so the count below means something.
      expect(psCalls).toBe(1)
      for (let i = 0; i < 200; i++) detectCurrentAgent()
      expect(psCalls).toBe(1)
    } finally {
      Bun.spawnSync = originalSpawnSync
      resetParentProcessCommandCacheForTests()
      for (const [name, value] of savedEnv) {
        if (value !== undefined) process.env[name] = value
      }
    }
  })
})

describe("Antigravity parent process recognition", () => {
  const pattern = getAgent("antigravity")!.processPattern!

  test.each([
    "agy",
    "/usr/local/bin/agy --resume session",
    "/opt/bin/antigravity --session lane",
    "node /opt/tools/agy.js --resume session",
    "/opt/bin/bun /opt/tools/antigravity.mjs",
  ])("recognises the actual launcher: %s", (command) => {
    expect(pattern.test(command)).toBe(true)
  })

  test.each([
    "bun test src/tasks/task-store-migration.test.ts src/transcript-antigravity.test.ts",
    "/opt/bin/bun test src/commands/doctor/cleanup-antigravity.test.ts",
    "bun test agy.test.ts",
    "git show docs/antigravity.md",
    "sh -c echo antigravity",
    "node /opt/antigravity-tests/runner.js",
    "agy-helper --version",
  ])("ignores an incidental name: %s", (command) => {
    expect(pattern.test(command)).toBe(false)
  })
})
