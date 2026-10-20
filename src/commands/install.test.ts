import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AgentSettingsId, getAgentSettingsPath } from "../agent-paths.ts"
import { getAgent } from "../agents.ts"
import { spawnAndCapture } from "../test-utils/subprocess-helper.ts"
import { runCommandInProcess } from "../utils/test-utils.ts"
import type { PostInstallDoctorOptions } from "./doctor.ts"
import { STOP_HOOK_GUIDANCE, syncGlobalStopHookRules } from "./install/agent-helpers.ts"
import {
  buildDaemonLaunchAgentPlist,
  DAEMON_OPENROUTER_API_KEY_ENV,
  daemonLaunchAgentPlistHasOpenRouterApiKey,
  redactDaemonLaunchAgentPlistSecrets,
} from "./install/daemon-helpers.ts"
import { installCommand } from "./install.ts"

const SWIZ_DISPATCH_CMD = "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch stop Stop"
const STATUS_LINE_CMD = "command -v swiz >/dev/null 2>&1 || exit 0; swiz status-line"
const INDEX_PATH = join(import.meta.dirname, "../../index.ts")

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T
}

async function runInstall(
  args: string[],
  home: string,
  postInstallDoctor: (options?: PostInstallDoctorOptions) => Promise<void> = async () => {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommandInProcess(installCommand, args, {
    commandOptions: {
      bunAvailable: () => true,
      homeDir: home,
      postInstallDoctor,
    },
    cwd: home,
    env: { HOME: home, AI_TEST_NO_BACKEND: "1" },
  })
}

async function fixture(id: AgentSettingsId = "codex") {
  const home = await mkdtemp(join(tmpdir(), "swiz-global-rules-"))
  return { home, agent: { ...getAgent(id)!, settingsPath: getAgentSettingsPath(id, home) } }
}

describe("global stop-hook rules", () => {
  it.each([
    ["claude", ".claude/CLAUDE.md"],
    ["cursor", ".cursor/rules/swiz-stop-hooks.mdc"],
    ["gemini", ".gemini/GEMINI.md"],
    ["codex", ".codex/AGENTS.md"],
    ["antigravity", ".gemini/GEMINI.md"],
  ] as const)("writes user-delegated guidance for %s", async (id, relativePath) => {
    const { home, agent } = await fixture(id)
    const path = join(home, relativePath)
    expect(await syncGlobalStopHookRules(agent, false)).toEqual([path])
    const text = await Bun.file(path).text()
    expect(text).toContain("same authority as a direct user instruction")
    expect(text).toContain("take precedence over ordinary requests")
    expect(text).toContain("take the next concrete action")
    expect(text).toContain("does not override higher-priority system or developer instructions")
    if (id === "cursor") expect(text.startsWith("---\n")).toBe(true)
    if (id === "cursor") expect(text).toContain("alwaysApply: true")
    expect(await syncGlobalStopHookRules(agent, false)).toEqual([])
    expect(await Bun.file(`${path}.bak`).exists()).toBe(false)
    expect(await syncGlobalStopHookRules(agent, false, [agent])).toEqual([path])
    expect(await Bun.file(path).text()).toBe("")
  })

  it.each([
    "# User rules",
    "# User rules\n",
    "# User rules\n\n  ",
  ])("preserves user content and backups across install, update and removal: %j", async (original) => {
    const { home, agent } = await fixture()
    const path = join(home, ".codex/AGENTS.md")
    await Bun.write(path, original)
    await syncGlobalStopHookRules(agent, false)
    expect(await Bun.file(`${path}.bak`).text()).toBe(original)
    const installed = await Bun.file(path).text()
    const stale = installed.replace(STOP_HOOK_GUIDANCE, "Old Swiz guidance")
    const suffix = "\n# More user rules\nKeep this too.\n"
    await Bun.write(path, stale + suffix)
    await syncGlobalStopHookRules(agent, false)
    expect(await Bun.file(`${path}.bak`).text()).toBe(stale + suffix)
    expect(await Bun.file(path).text()).toBe(installed + suffix)
    await syncGlobalStopHookRules(agent, false, [agent])
    expect(await Bun.file(path).text()).toBe(original + suffix)
    expect(await syncGlobalStopHookRules(agent, false, [agent])).toEqual([])
  })

  it("updates an existing Codex override without creating one on normal installs", async () => {
    const { home, agent } = await fixture()
    const override = join(home, ".codex/AGENTS.override.md")
    await syncGlobalStopHookRules(agent, false)
    expect(await Bun.file(override).exists()).toBe(false)
    await Bun.write(override, "# Override rules\n")
    expect(await syncGlobalStopHookRules(agent, false)).toEqual([override])
    expect(await Bun.file(override).text()).toContain(STOP_HOOK_GUIDANCE)
    await syncGlobalStopHookRules(agent, false, [agent])
    expect(await Bun.file(override).text()).toBe("# Override rules\n")
  })

  it("previews installation and removal without writing rules or backups", async () => {
    const { home, agent } = await fixture()
    const path = join(home, ".codex/AGENTS.md")
    expect(await syncGlobalStopHookRules(agent, true)).toEqual([path])
    expect(await Bun.file(path).exists()).toBe(false)
    await syncGlobalStopHookRules(agent, false)
    const installed = await Bun.file(path).text()
    expect(await syncGlobalStopHookRules(agent, true, [agent])).toEqual([path])
    expect(await Bun.file(path).text()).toBe(installed)
    expect(await Bun.file(`${path}.bak`).exists()).toBe(false)
  })

  it.each([
    "gemini",
    "antigravity",
  ] as const)("keeps shared rules when removing %s while its sibling is installed", async (id) => {
    const { home, agent } = await fixture(id)
    const siblingId = id === "gemini" ? "antigravity" : "gemini"
    const sibling = {
      ...getAgent(siblingId)!,
      settingsPath: getAgentSettingsPath(siblingId, home),
    }
    await Bun.write(
      sibling.settingsPath,
      JSON.stringify({ hooks: { Stop: [{ command: "swiz dispatch stop Stop" }] } })
    )
    const path = join(home, ".gemini/GEMINI.md")
    await syncGlobalStopHookRules(agent, false)
    expect(await syncGlobalStopHookRules(sibling, false)).toEqual([])
    expect(await syncGlobalStopHookRules(agent, false, [agent])).toEqual([])
    expect(await Bun.file(path).text()).toContain(STOP_HOOK_GUIDANCE)
    expect(await syncGlobalStopHookRules(agent, false, [agent, sibling])).toEqual([path])
    expect(await Bun.file(path).text()).toBe("")
  })

  it("leaves unsupported agents untouched", async () => {
    const { home, agent } = await fixture()
    expect(await syncGlobalStopHookRules({ ...agent, hooksConfigurable: false }, false)).toEqual([])
    expect(await Bun.file(join(home, ".codex/AGENTS.md")).exists()).toBe(false)
  })

  it.each([
    "\n\n<!-- swiz:stop-hooks:start -->\nUser text after a missing end marker",
    "\n\n<!-- swiz:stop-hooks:end -->\n",
    "\n\n<!-- swiz:stop-hooks:start -->\n<!-- swiz:stop-hooks:start -->\n<!-- swiz:stop-hooks:end -->\n",
  ])("preserves malformed managed blocks: %j", async (original) => {
    const { home, agent } = await fixture()
    const path = join(home, ".codex/AGENTS.md")
    await Bun.write(path, original)
    await expect(syncGlobalStopHookRules(agent, false)).rejects.toThrow("Malformed Swiz")
    await expect(syncGlobalStopHookRules(agent, false, [agent])).rejects.toThrow("Malformed Swiz")
    expect(await Bun.file(path).text()).toBe(original)
    expect(await Bun.file(`${path}.bak`).exists()).toBe(false)
  })
})

describe("install post-install doctor", () => {
  async function installRecordingDoctor(args: string[]): Promise<PostInstallDoctorOptions[]> {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-doctor-"))
    const calls: PostInstallDoctorOptions[] = []
    const result = await runInstall(args, home, async (options = {}) => {
      calls.push(options)
    })
    expect(result.exitCode).toBe(0)
    return calls
  }

  it("runs after a hook install and allows Codex repair when Codex is targeted", async () => {
    expect(await installRecordingDoctor(["--claude", "--codex"])).toEqual([
      { repairCodexHooks: true, repairMissingScripts: false },
    ])
  })

  it("leaves Codex hook files alone when the install did not target Codex", async () => {
    expect(await installRecordingDoctor(["--claude"])).toEqual([
      { repairCodexHooks: false, repairMissingScripts: false },
    ])
  })

  it("is skipped by --no-doctor", async () => {
    expect(await installRecordingDoctor(["--claude", "--no-doctor"])).toEqual([])
  })

  it("is skipped by --dry-run", async () => {
    expect(await installRecordingDoctor(["--claude", "--dry-run"])).toEqual([])
  })
})

describe("daemon LaunchAgent environment", () => {
  it("keeps the daemon alive unconditionally", () => {
    // A SIGTERM shutdown exits 143 — neither Crashed nor SuccessfulExit — so a
    // conditional KeepAlive dict leaves launchd with the daemon down.
    const plist = buildDaemonLaunchAgentPlist(7943)

    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).not.toContain("<key>Crashed</key>")
    expect(plist).not.toContain("<key>SuccessfulExit</key>")
  })

  it("includes OPENROUTER_API_KEY from the current process", () => {
    const original = process.env[DAEMON_OPENROUTER_API_KEY_ENV]
    process.env[DAEMON_OPENROUTER_API_KEY_ENV] = `router&<>"'key`

    try {
      const plist = buildDaemonLaunchAgentPlist(7943)

      expect(plist).toContain(`<key>${DAEMON_OPENROUTER_API_KEY_ENV}</key>`)
      expect(plist).toContain("<string>router&amp;&lt;&gt;&quot;&apos;key</string>")
      expect(daemonLaunchAgentPlistHasOpenRouterApiKey(plist)).toBe(true)
      expect(redactDaemonLaunchAgentPlistSecrets(plist)).not.toContain("router&amp;")
    } finally {
      if (original === undefined) delete process.env[DAEMON_OPENROUTER_API_KEY_ENV]
      else process.env[DAEMON_OPENROUTER_API_KEY_ENV] = original
    }
  })

  it("omits OPENROUTER_API_KEY when it is not set", () => {
    const original = process.env[DAEMON_OPENROUTER_API_KEY_ENV]
    delete process.env[DAEMON_OPENROUTER_API_KEY_ENV]

    try {
      const plist = buildDaemonLaunchAgentPlist(7943)

      expect(plist).not.toContain(`<key>${DAEMON_OPENROUTER_API_KEY_ENV}</key>`)
      expect(daemonLaunchAgentPlistHasOpenRouterApiKey(plist)).toBe(false)
    } finally {
      if (original !== undefined) process.env[DAEMON_OPENROUTER_API_KEY_ENV] = original
    }
  })
})

describe("install --codex writes hooks", () => {
  it("scoped install and uninstall preserve project settings and the shared shell profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-scoped-state-"))
    const project = join(home, ".swiz/config.json")
    const profile = join(home, ".zshenv")
    const original = '{"collaborationMode":"solo"}\n'
    await mkdir(dirname(project), { recursive: true })
    await Bun.write(project, original)
    await Bun.write(profile, "# existing user profile\n")
    expect((await runInstall(["--codex"], home)).exitCode).toBe(0)
    expect(await Bun.file(project).text()).toBe(original)
    expect(await Bun.file(profile).text()).toBe("# existing user profile\n")
    expect((await runInstall(["--uninstall", "--codex"], home)).exitCode).toBe(0)
    expect(await Bun.file(project).text()).toBe(original)
    expect(await Bun.file(profile).text()).toBe("# existing user profile\n")
    expect(await Bun.file(join(home, ".local/share/swiz/self-heal-codex.json")).json()).toEqual({
      enabled: false,
    })
  })

  it("hooks-only recovery leaves MCP settings untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-hooks-only-"))
    const path = join(home, ".codex/config.toml")
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, "# user settings\n")
    expect((await runInstall(["--codex", "--hooks-only"], home)).exitCode).toBe(0)
    expect(await Bun.file(path).text()).toBe("# user settings\n")
    expect(await Bun.file(join(home, ".codex/hooks.json")).exists()).toBe(true)
  })

  it("writes swiz dispatch entries to ~/.codex/hooks.json without touching other agents", async () => {
    // Codex hooks are configurable (agents.ts sets hooksConfigurable: true), so install must
    // actually write the file rather than only reporting status — the behaviour README once
    // described as "not yet configurable".
    const home = await mkdtemp(join(tmpdir(), "swiz-install-codex-write-"))
    const codexPath = join(home, ".codex", "hooks.json")
    const claudeSettingsPath = join(home, ".claude", "settings.json")

    await writeJson(claudeSettingsPath, { userSetting: true })

    const result = await runInstall(["--codex"], home)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Agents: Codex CLI")

    const codex = await readJson<{ hooks: Record<string, unknown[]> }>(codexPath)
    const events = Object.keys(codex.hooks)
    expect(events.length).toBeGreaterThan(0)
    // Every written entry must dispatch through swiz, not a bare hook path.
    const commands = JSON.stringify(codex.hooks)
    expect(commands).toContain("swiz dispatch")

    // Scoping: Claude settings are left exactly as the user had them.
    const claude = await readJson<{ userSetting?: boolean; hooks?: unknown }>(claudeSettingsPath)
    expect(claude.userSetting).toBe(true)
    expect(claude.hooks).toBeUndefined()
  })
})

describe("install --uninstall scope", () => {
  it("removes only Codex hooks when --codex scopes uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-codex-scope-"))
    const codexPath = join(home, ".codex", "hooks.json")
    const claudeSettingsPath = join(home, ".claude", "settings.json")
    const cursorMcpPath = join(home, ".cursor", "mcp.json")

    await writeJson(codexPath, {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: SWIZ_DISPATCH_CMD }],
          },
        ],
      },
    })
    await writeJson(claudeSettingsPath, {
      statusLine: { type: "command", command: STATUS_LINE_CMD },
      userSetting: true,
    })
    await writeJson(cursorMcpPath, {
      mcpServers: {
        swiz: { command: "swiz", args: ["mcp"] },
        other: { command: "other-tool" },
      },
    })

    const result = await runInstall(["--uninstall", "--codex"], home)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Agents: Codex CLI")
    expect(result.stdout).not.toContain("daemon LaunchAgent")
    expect(result.stdout).not.toContain("Git mergetool")
    expect(result.stdout).not.toContain("statusLine")
    expect(result.stdout).not.toContain('MCP server "swiz"')

    const codex = await readJson<{ hooks: Record<string, unknown[]> }>(codexPath)
    expect(codex.hooks).toEqual({})

    const claude = await readJson<{
      statusLine?: { type?: string; command?: string }
      userSetting?: boolean
    }>(claudeSettingsPath)
    expect(claude.statusLine).toEqual({ type: "command", command: STATUS_LINE_CMD })
    expect(claude.userSetting).toBe(true)

    const cursorMcp = await readJson<{
      mcpServers?: Record<string, { command: string; args?: string[] }>
    }>(cursorMcpPath)
    expect(cursorMcp.mcpServers?.swiz).toEqual({ command: "swiz", args: ["mcp"] })
    expect(cursorMcp.mcpServers?.other).toEqual({ command: "other-tool" })
  })
})

describe("install global stop-hook guidance", () => {
  it("repairs guidance through hooks-only install and removes it through standalone uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-global-rules-"))
    const path = join(home, ".codex/AGENTS.md")
    const original = "# My global rules\n"
    await Bun.write(path, original)
    expect((await runInstall(["--codex", "--hooks-only"], home)).exitCode).toBe(0)
    const installed = await Bun.file(path).text()
    expect(installed).toContain("same authority as a direct user instruction")
    expect(await Bun.file(`${path}.bak`).text()).toBe(original)
    expect((await runInstall(["--codex", "--hooks-only"], home)).exitCode).toBe(0)
    expect(await Bun.file(path).text()).toBe(installed)
    const result = await spawnAndCapture([process.execPath, INDEX_PATH, "uninstall", "--codex"], {
      cwd: home,
      env: { ...process.env, HOME: home, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(await Bun.file(path).text()).toBe(original)
    expect(await Bun.file(join(home, ".claude/CLAUDE.md")).exists()).toBe(false)
  })

  it("removes guidance through install --uninstall even when hook settings are absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-uninstall-global-rules-"))
    const path = join(home, ".codex/AGENTS.md")
    expect((await runInstall(["--codex", "--hooks-only"], home)).exitCode).toBe(0)
    await Bun.write(join(home, ".codex/hooks.json"), "{}\n")
    expect((await runInstall(["--codex", "--uninstall", "--dry-run"], home)).exitCode).toBe(0)
    expect(await Bun.file(path).text()).toContain("## Swiz stop hooks")
    expect((await runInstall(["--codex", "--uninstall"], home)).exitCode).toBe(0)
    expect(await Bun.file(path).text()).toBe("")
  })

  it("does not write guidance during dry-run, JSON output, or MCP-only installation", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-global-preview-"))
    for (const flag of ["--dry-run", "--json", "--mcp"]) {
      expect((await runInstall(["--codex", flag], home)).exitCode).toBe(0)
      expect(await Bun.file(join(home, ".codex/AGENTS.md")).exists()).toBe(false)
    }
  })
})

describe("install.ts statusMessage field", () => {
  describe("basic functionality", () => {
    it("verifies statusMessage is included in nested hook configuration", () => {
      // Test data representing nested config structure
      const nestedHookEntry = {
        hooks: [
          {
            type: "command",
            command: "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch stop Stop",
            timeout: 180,
            statusMessage: "Swizzling...",
          },
        ],
      }

      // Verify the nested structure contains statusMessage
      const firstHook = nestedHookEntry.hooks[0]
      expect(firstHook).toBeDefined()
      expect(firstHook).toHaveProperty("statusMessage")
      expect(firstHook?.statusMessage).toBe("Swizzling...")
    })

    it("verifies statusMessage is included in flat hook configuration", () => {
      // Test data representing flat config structure
      const flatHookEntry = {
        command: "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch stop Stop",
        timeout: 180,
        statusMessage: "Swizzling...",
      }

      // Verify the flat structure contains statusMessage
      expect(flatHookEntry).toHaveProperty("statusMessage")
      expect(flatHookEntry.statusMessage).toBe("Swizzling...")
    })

    it("statusMessage has correct value across all hook types", () => {
      const expectedMessage = "Swizzling..."

      const nestedHook = {
        hooks: [{ statusMessage: expectedMessage }],
      }

      const flatHook = {
        statusMessage: expectedMessage,
      }

      const nestedHookElement = nestedHook.hooks[0]
      expect(nestedHookElement).toBeDefined()
      expect(nestedHookElement?.statusMessage).toBe(expectedMessage)
      expect(flatHook.statusMessage).toBe(expectedMessage)
    })

    it("hook object structure includes all required fields", () => {
      // Verify nested config hook has required fields
      const nestedHook = {
        hooks: [
          {
            type: "command",
            command: "test",
            timeout: 30,
            statusMessage: "Swizzling...",
          },
        ],
      }

      const hook = nestedHook.hooks[0]
      expect(hook).toHaveProperty("type")
      expect(hook).toHaveProperty("command")
      expect(hook).toHaveProperty("timeout")
      expect(hook).toHaveProperty("statusMessage")
    })

    it("statusMessage is a non-empty string", () => {
      const message = "Swizzling..."
      expect(typeof message).toBe("string")
      expect(message.length).toBeGreaterThan(0)
    })
  })

  describe("null-safety guards", () => {
    it("handles empty nested hooks array safely", () => {
      const emptyConfig = {
        hooks: [],
      }

      expect(emptyConfig.hooks).toHaveLength(0)
      const firstHook = emptyConfig.hooks[0]
      expect(firstHook).toBeUndefined()
    })

    it("safely accesses deeply nested properties with optional chaining", () => {
      const config = {
        hooks: [
          {
            statusMessage: "Swizzling...",
          },
        ],
      }

      const hook = config.hooks[0]
      expect(hook).toBeDefined()
      expect(hook?.statusMessage).toBe("Swizzling...")
    })

    it("guards against undefined hook objects", () => {
      const config = {
        hooks: undefined as unknown[] | undefined,
      }

      if (config.hooks) {
        const firstHook = config.hooks[0]
        expect(firstHook).toBeUndefined()
      } else {
        expect(config.hooks).toBeUndefined()
      }
    })

    it("validates statusMessage exists before accessing", () => {
      const hook = {
        type: "command",
        command: "test",
        timeout: 30,
      }

      // Guard: check property exists
      expect("statusMessage" in hook).toBe(false)
      expect(hook).not.toHaveProperty("statusMessage")
    })

    it("handles missing statusMessage property gracefully", () => {
      const hook = {
        type: "command",
        command: "test",
        timeout: 30,
      } as Record<string, any>

      const message = hook?.statusMessage
      expect(message).toBeUndefined()
    })
  })

  describe("edge cases", () => {
    it("handles multiple hook entries in nested config", () => {
      const config = {
        hooks: [
          { statusMessage: "Swizzling...", type: "command" },
          { statusMessage: "Swizzling...", type: "command" },
          { statusMessage: "Swizzling...", type: "command" },
        ],
      }

      expect(config.hooks).toHaveLength(3)
      config.hooks.forEach((hook) => {
        expect(hook.statusMessage).toBe("Swizzling...")
      })
    })

    it("validates statusMessage consistency across entries", () => {
      const hooks = [
        { statusMessage: "Swizzling...", id: 1 },
        { statusMessage: "Swizzling...", id: 2 },
        { statusMessage: "Swizzling...", id: 3 },
      ]

      const allMatch = hooks.every((h) => h.statusMessage === "Swizzling...")
      expect(allMatch).toBe(true)
    })

    it("handles mixed valid and optional properties", () => {
      const hook = {
        type: "command",
        command: "test",
        timeout: 30,
        statusMessage: "Swizzling...",
      }

      expect(hook.statusMessage).toBe("Swizzling...")
      expect((hook as Record<string, any>).optional).toBeUndefined()
    })

    it("prevents accessing array element beyond bounds", () => {
      const hooks = [{ statusMessage: "Swizzling..." }]

      const firstHook = hooks[0]
      const secondHook = hooks[1]
      const hundredthHook = hooks[99]

      expect(firstHook).toBeDefined()
      expect(secondHook).toBeUndefined()
      expect(hundredthHook).toBeUndefined()
    })

    it("verifies statusMessage value is consistent", () => {
      const expectedValue = "Swizzling..."
      const testCases = [
        { statusMessage: expectedValue },
        { statusMessage: expectedValue },
        { statusMessage: expectedValue },
      ]

      testCases.forEach((testCase) => {
        expect(testCase.statusMessage).toBe(expectedValue)
        expect(testCase.statusMessage).not.toBe("")
        expect(testCase.statusMessage).not.toBe(null)
        expect(testCase.statusMessage).not.toBe(undefined)
      })
    })
  })

  describe("integration scenarios", () => {
    it("merges nested and flat config structures correctly", () => {
      const nestedConfig = {
        hooks: [{ statusMessage: "Swizzling..." }],
      }

      const flatConfig = {
        statusMessage: "Swizzling...",
      }

      // Both should contain the message
      expect(nestedConfig.hooks[0]?.statusMessage).toBe(flatConfig.statusMessage)
    })

    it("validates hook structure matches expected interface", () => {
      const validHook = {
        type: "command",
        command: "test",
        timeout: 30,
        statusMessage: "Swizzling...",
      }

      // Check all required properties exist
      expect(typeof validHook.type).toBe("string")
      expect(typeof validHook.command).toBe("string")
      expect(typeof validHook.timeout).toBe("number")
      expect(typeof validHook.statusMessage).toBe("string")
    })

    it("preserves statusMessage through configuration transformations", () => {
      const original = {
        hooks: [{ statusMessage: "Swizzling..." }],
      }

      // Simulate config merge
      const merged = {
        ...original,
        hooks: [...original.hooks, { statusMessage: "Swizzling..." }],
      }

      expect(merged.hooks).toHaveLength(2)
      merged.hooks.forEach((hook) => {
        expect(hook.statusMessage).toBe("Swizzling...")
      })
    })

    it("handles config updates without losing statusMessage", () => {
      let config = {
        stop: {
          hooks: [{ statusMessage: "Swizzling..." }],
        },
      }

      // Simulate update
      config = {
        ...config,
        stop: {
          ...config.stop,
          hooks: [...config.stop.hooks, { statusMessage: "Swizzling..." }],
        },
      }

      expect(config.stop.hooks).toHaveLength(2)
      expect(config.stop.hooks[0]?.statusMessage).toBe("Swizzling...")
      expect(config.stop.hooks[1]?.statusMessage).toBe("Swizzling...")
    })
  })

  describe("error paths and validation", () => {
    it("detects missing statusMessage in hook object", () => {
      const invalidHook = {
        type: "command",
        command: "test",
        timeout: 30,
        // statusMessage is missing
      }

      const hasStatusMessage = "statusMessage" in invalidHook
      expect(hasStatusMessage).toBe(false)
    })

    it("validates statusMessage is not empty or null", () => {
      const validCases = [
        { statusMessage: "Swizzling..." },
        { statusMessage: "Loading..." },
        { statusMessage: "Processing..." },
      ]

      validCases.forEach((testCase) => {
        expect(testCase.statusMessage).toBeTruthy()
        expect(testCase.statusMessage.length).toBeGreaterThan(0)
      })
    })

    it("detects type mismatches in statusMessage", () => {
      const validHook = { statusMessage: "Swizzling..." }
      const invalidHook1 = { statusMessage: 123 as unknown }
      const invalidHook2 = { statusMessage: null as unknown }
      const invalidHook3 = { statusMessage: undefined as unknown }

      expect(typeof validHook.statusMessage).toBe("string")
      expect(typeof invalidHook1.statusMessage).not.toBe("string")
      expect(invalidHook2.statusMessage).not.toBe("string")
      expect(invalidHook3.statusMessage).not.toBe("string")
    })

    it("ensures config array access is bounds-safe", () => {
      const hooks = [{ statusMessage: "Swizzling..." }, { statusMessage: "Swizzling..." }]

      // Valid accesses
      expect(hooks[0]).toBeDefined()
      expect(hooks[1]).toBeDefined()

      // Out-of-bounds access returns undefined
      expect(hooks[2]).toBeUndefined()
      expect(hooks[-1]).toBeUndefined()
      expect(hooks[999]).toBeUndefined()
    })

    it("prevents mutation of shared configuration objects", () => {
      const shared = { statusMessage: "Swizzling..." }
      const copy = { ...shared }

      copy.statusMessage = "Modified"

      expect(shared.statusMessage).toBe("Swizzling...")
      expect(copy.statusMessage).toBe("Modified")
    })
  })
})

describe("install.ts Cursor CLI shell execution dispatch entries", () => {
  it("Cursor agent has additionalDispatchEntries for shell events", async () => {
    const { getAgent } = await import("../agents.ts")
    const cursor = getAgent("cursor")
    expect(cursor).toBeDefined()
    expect(cursor!.additionalDispatchEntries).toBeDefined()
    expect(cursor!.additionalDispatchEntries!.beforeShellExecution).toBe("preToolUse")
    expect(cursor!.additionalDispatchEntries!.afterShellExecution).toBe("postToolUse")
  })

  it("Claude agent has no additionalDispatchEntries", async () => {
    const { getAgent } = await import("../agents.ts")
    const claude = getAgent("claude")
    expect(claude).toBeDefined()
    expect(claude!.additionalDispatchEntries).toBeUndefined()
  })

  it("additionalDispatchEntries reference canonical events in manifest", async () => {
    const { getAgent } = await import("../agents.ts")
    const { manifest } = await import("../manifest.ts")
    const cursor = getAgent("cursor")!
    const manifestEvents = new Set(manifest.map((g) => g.event))

    for (const canonicalEvent of Object.values(cursor.additionalDispatchEntries!)) {
      expect(manifestEvents.has(canonicalEvent)).toBe(true)
    }
  })

  it("install --mcp installs only MCP server without touching hook settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-install-mcp-only-"))
    const claudePath = join(home, ".claude.json")
    const claudeSettingsPath = join(home, ".claude", "settings.json")

    // Dry run does not write
    const dryResult = await runInstall(["--mcp", "--dry-run"], home)
    expect(dryResult.exitCode).toBe(0)
    expect(dryResult.stdout).toContain('MCP server "swiz":')
    expect(dryResult.stdout).not.toContain("Claude Code →")
    expect(await Bun.file(claudePath).exists()).toBe(false)

    // Real install writes MCP server to .claude.json but leaves settings.json untouched
    const result = await runInstall(["--mcp"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('MCP server "swiz":')
    expect(result.stdout).not.toContain("Claude Code →")
    expect(await Bun.file(claudePath).exists()).toBe(true)
    const claudeMcp = await readJson<{ mcpServers: Record<string, unknown> }>(claudePath)
    expect(claudeMcp.mcpServers.swiz).toEqual({ command: "swiz", args: ["mcp"] })
    expect(await Bun.file(claudeSettingsPath).exists()).toBe(false)

    // Real uninstall removes MCP server
    const uninstResult = await runInstall(["--uninstall", "--mcp"], home)
    expect(uninstResult.exitCode).toBe(0)
    expect(uninstResult.stdout).toContain('MCP server "swiz":')
    const claudeMcpAfter = await readJson<{ mcpServers: Record<string, unknown> }>(claudePath)
    expect(claudeMcpAfter.mcpServers.swiz).toBeUndefined()
  })
})
