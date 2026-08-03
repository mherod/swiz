import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SwizHook } from "../SwizHook.ts"
import { executeDispatch } from "./execute.ts"

describe("daemon-backed effective settings", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("injects project settings when the daemon supplies a cached manifest", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-effective-settings-project-"))
    const settingsHome = await mkdtemp(join(tmpdir(), "swiz-effective-settings-home-"))
    tempDirs.push(projectDir, settingsHome)

    await mkdir(join(projectDir, ".swiz"), { recursive: true })
    await Bun.write(join(projectDir, ".swiz", "config.json"), JSON.stringify({ trunkMode: true }))

    let injectedTrunkMode: boolean | undefined
    const settingsProbe: SwizHook = {
      name: "effective-settings-probe",
      event: "preToolUse",
      matcher: "Bash",
      run(input: Record<string, any>) {
        injectedTrunkMode = input._effectiveSettings?.trunkMode
        return {}
      },
    }

    await executeDispatch({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: projectDir,
        session_id: "effective-settings-test",
        tool_name: "Bash",
        tool_input: { command: "echo probe" },
      }),
      daemonContext: true,
      settingsHomeOverride: settingsHome,
      manifestProvider: async () => [
        {
          event: "preToolUse",
          matcher: "Bash",
          hooks: [{ hook: settingsProbe }],
        },
      ],
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: projectDir,
        repoKey: "effective-settings-test",
        isRepo: true,
        repoSlug: null,
        hasGhCli: true,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    })

    expect(injectedTrunkMode).toBe(true)
  })
})
