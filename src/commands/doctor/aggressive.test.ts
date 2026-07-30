import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgentSettingsPath } from "../../agent-paths.ts"
import { getAgent } from "../../agents.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import { collectCommands } from "../install/config-helpers.ts"
import { replaceAgentHooksWithSwiz, stripCodexHooksFromToml } from "./aggressive.ts"

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

  test("clears every editable Codex hook layer and reports retained sources", async () => {
    const home = await createTempHome()
    const codex = getAgent("codex")!
    const codexHome = join(home, ".codex")
    const primaryPath = getAgentSettingsPath("codex", home)
    const userConfigPath = join(codexHome, "config.toml")
    const profilePath = join(codexHome, "review.config.toml")
    const projectRoot = join(home, "project")
    const nestedCwd = join(projectRoot, "packages", "api")
    const projectHooksPath = join(projectRoot, ".codex", "hooks.json")
    const nestedConfigPath = join(nestedCwd, ".codex", "config.toml")

    await mkdir(join(projectRoot, ".git"), { recursive: true })
    await mkdir(dirname(primaryPath), { recursive: true })
    await mkdir(dirname(projectHooksPath), { recursive: true })
    await mkdir(dirname(nestedConfigPath), { recursive: true })

    await Bun.write(
      primaryPath,
      JSON.stringify({
        description: "user hooks",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo global-user-hook" }] }],
        },
      })
    )
    await Bun.write(
      userConfigPath,
      [
        'model = "gpt-test"',
        "",
        "[[hooks.PreToolUse]]",
        'matcher = "^Bash$"',
        "",
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        'command = "echo inline-user-hook"',
        "",
        "[features]",
        "hooks = true",
        "",
      ].join("\n")
    )
    await Bun.write(
      profilePath,
      [
        'model = "gpt-profile"',
        'hooks.Stop = [{ hooks = [{ type = "command", command = "echo profile-hook" }] }]',
        "",
      ].join("\n")
    )
    await Bun.write(
      projectHooksPath,
      JSON.stringify({
        description: "project hooks",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo project-hook" }] }],
        },
      })
    )
    await Bun.write(
      nestedConfigPath,
      [
        'model_reasoning_effort = "high"',
        "",
        "[[hooks.Stop]]",
        "",
        "[[hooks.Stop.hooks]]",
        'type = "command"',
        'command = "echo nested-hook"',
        "",
      ].join("\n")
    )

    const replacements = await replaceAgentHooksWithSwiz([codex], home, {
      cwd: nestedCwd,
      discoverCodexHooks: async () => [
        {
          key: `${projectHooksPath}:stop:0:0`,
          eventName: "stop",
          handlerType: "command",
          matcher: null,
          command: "echo project-hook",
          timeoutSec: 10,
          statusMessage: null,
          sourcePath: projectHooksPath,
          source: "project",
          isManaged: false,
          pluginId: null,
          enabled: true,
          trustStatus: "trusted",
          currentHash: "sha256:project",
        },
        {
          key: "/<enterprise-managed:Baseline>/requirements.toml:pre_tool_use:0:0",
          eventName: "preToolUse",
          handlerType: "command",
          matcher: "^Bash$",
          command: "python3 pushpatrol.py",
          timeoutSec: 10,
          statusMessage: "Checking PushPatrol bypass policy",
          sourcePath: "/<enterprise-managed:Baseline>/requirements.toml",
          source: "cloudRequirements",
          isManaged: true,
          pluginId: null,
          enabled: true,
          trustStatus: "managed",
          currentHash: "sha256:managed",
        },
        {
          key: "/plugins/policy/hooks/hooks.json:stop:0:0",
          eventName: "stop",
          handlerType: "command",
          matcher: null,
          command: "bun plugin-hook.ts",
          timeoutSec: null,
          statusMessage: null,
          sourcePath: "/plugins/policy/hooks/hooks.json",
          source: "plugin",
          isManaged: false,
          pluginId: "policy",
          enabled: true,
          trustStatus: "trusted",
          currentHash: "sha256:plugin",
        },
      ],
    })

    const primary = (await Bun.file(primaryPath).json()) as Record<string, any>
    const projectHooks = (await Bun.file(projectHooksPath).json()) as Record<string, any>
    const userConfig = await Bun.file(userConfigPath).text()
    const profile = await Bun.file(profilePath).text()
    const nestedConfig = await Bun.file(nestedConfigPath).text()
    const commands = [...collectCommands(primary.hooks)]
    const replacement = replacements[0]!

    expect(commands).toHaveLength(5)
    expect(commands.every((command) => command.includes("swiz dispatch --agent codex"))).toBe(true)
    expect(primary.description).toBe("user hooks")
    expect(projectHooks).toEqual({ description: "project hooks", hooks: {} })
    expect(userConfig).toContain('model = "gpt-test"')
    expect(userConfig).toContain("[features]")
    expect(userConfig).not.toContain("[[hooks.")
    expect(profile).toContain('model = "gpt-profile"')
    expect(profile).not.toContain("hooks.Stop")
    expect(nestedConfig).toContain('model_reasoning_effort = "high"')
    expect(nestedConfig).not.toContain("[[hooks.")
    expect(await Bun.file(`${userConfigPath}.bak`).exists()).toBe(true)
    expect(await Bun.file(`${profilePath}.bak`).exists()).toBe(true)
    expect(await Bun.file(`${projectHooksPath}.bak`).exists()).toBe(true)
    expect(await Bun.file(`${nestedConfigPath}.bak`).exists()).toBe(true)
    expect(replacement.removedHookCount).toBe(5)
    expect(replacement.cleanedSourceCount).toBe(5)
    expect(replacement.retainedHookCount).toBe(2)
    expect(replacement.retainedHookSources).toEqual(["managed:cloudRequirements", "plugin:policy"])
    expect(replacement.retainedHooks).toEqual([
      expect.objectContaining({
        eventName: "preToolUse",
        matcher: "^Bash$",
        statusMessage: "Checking PushPatrol bypass policy",
      }),
      expect.objectContaining({
        eventName: "stop",
        pluginId: "policy",
      }),
    ])
    expect(replacement.hookDiscoveryComplete).toBe(true)
  })

  test("removes a multiline top-level hooks assignment without touching later tables", () => {
    const input = [
      'model = "gpt-test"',
      "hooks = [",
      '  { type = "command", command = "echo custom" },',
      "]",
      "",
      "[features]",
      "hooks = true",
      "",
    ].join("\n")

    const cleaned = stripCodexHooksFromToml(input)

    expect(cleaned).toContain('model = "gpt-test"')
    expect(cleaned).toContain("[features]")
    expect(cleaned).toContain("hooks = true")
    expect(cleaned).not.toContain("echo custom")
    expect(Bun.TOML.parse(cleaned)).toEqual({
      model: "gpt-test",
      features: { hooks: true },
    })
  })

  test("does not treat hook-shaped lines inside multiline strings as tables", () => {
    const input = [
      'model_instructions = """',
      "[hooks]",
      "This is documentation, not a TOML table.",
      '"""',
      "",
      "[[hooks.Stop]]",
      "",
      "[[hooks.Stop.hooks]]",
      'type = "command"',
      'command = "echo custom"',
      "",
      "[features]",
      "hooks = true",
      "",
    ].join("\n")

    const cleaned = stripCodexHooksFromToml(input)

    expect(cleaned).toContain("[hooks]\nThis is documentation")
    expect(cleaned).not.toContain("echo custom")
    expect(Bun.TOML.parse(cleaned)).toEqual({
      model_instructions: "\n[hooks]\nThis is documentation, not a TOML table.\n",
      features: { hooks: true },
    })
  })
})
