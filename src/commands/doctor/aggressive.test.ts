import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { getAgentSettingsPath } from "../../agent-paths.ts"
import { getAgent } from "../../agents.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import { collectCommands } from "../install/config-helpers.ts"
import { replaceAgentHooksWithSwiz } from "./aggressive.ts"

const { create: createTempHome } = useTempDir("swiz-doctor-aggressive-test-")

describe("replaceAgentHooksWithSwiz", () => {
  test("removes other Antigravity hook groups and keeps only swiz", async () => {
    const home = await createTempHome()
    const antigravity = getAgent("antigravity")!
    const settingsPath = getAgentSettingsPath("antigravity", home)
    await mkdir(dirname(settingsPath), { recursive: true })
    await Bun.write(
      settingsPath,
      JSON.stringify({
        custom: {
          Stop: [{ type: "command", command: "echo custom-hook", timeout: 5 }],
        },
        swiz: {
          Stop: [{ type: "command", command: "echo stale-swiz-hook", timeout: 5 }],
        },
      })
    )

    const replacements = await replaceAgentHooksWithSwiz([antigravity], home)
    const settings = (await Bun.file(settingsPath).json()) as Record<string, any>
    const backup = (await Bun.file(`${settingsPath}.bak`).json()) as Record<string, any>
    const commands = [...collectCommands(settings.swiz)]

    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.removedHookCount).toBe(2)
    expect(Object.keys(settings)).toEqual(["swiz"])
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((command) => command.includes("swiz dispatch --agent antigravity"))).toBe(
      true
    )
    expect(commands).not.toContain("echo custom-hook")
    expect(commands).not.toContain("echo stale-swiz-hook")
    expect(backup.custom.Stop[0].command).toBe("echo custom-hook")
  })
})
