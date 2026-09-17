import { describe, expect, test } from "bun:test"
import { mkdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  type LaunchAgentRuntime,
  readLaunchAgentPlist,
  SWIZ_CLEANUP_LABEL,
} from "../../launch-agents.ts"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { checkCleanupLaunchAgent } from "../doctor/checks/cleanup-launch-agent.ts"
import { installCommand } from "../install.ts"
import {
  buildCleanupLaunchAgentConfig,
  buildCleanupLaunchAgentPlist,
  type CleanupAgentOptions,
  inspectCleanupLaunchAgent,
  installCleanupLaunchAgent,
  uninstallCleanupLaunchAgent,
} from "./cleanup-agent.ts"

const temp = useTempDir("swiz-cleanup-agent-")

async function fixture() {
  const homeDir = await temp.create()
  const commands: string[][] = []
  const trashed: string[] = []
  const state = {
    loaded: false,
    config: null as object | null,
    loadExit: 0,
    unloadExit: 0,
    registers: true,
  }
  const runtime: LaunchAgentRuntime = {
    async run(command) {
      commands.push(command)
      if (command[0] === "plutil") {
        return { exitCode: state.config ? 0 : 1, stdout: JSON.stringify(state.config) }
      }
      if (command[1] === "print") return { exitCode: state.loaded ? 0 : 1, stdout: "" }
      if (command[1] === "bootout") {
        if (state.unloadExit === 0) state.loaded = false
        return { exitCode: state.unloadExit, stdout: "" }
      }
      if (command[1] === "bootstrap") {
        if (state.loadExit === 0 && state.registers) state.loaded = true
        return { exitCode: state.loadExit, stdout: "" }
      }
      throw new Error(`Unexpected command: ${command.join(" ")}`)
    },
    getUid: () => 501,
    kill: () => {
      throw new Error("Cleanup installation must not kill processes")
    },
  }
  const options: CleanupAgentOptions = {
    homeDir,
    projectRoot: "/test/Swiz & tools",
    bunPath: "/test/Bun & runtime/bun",
    platform: "darwin",
    runtime,
    trashPath: async (path) => {
      trashed.push(path)
      return true
    },
  }
  const plistPath = join(homeDir, "Library/LaunchAgents", `${SWIZ_CLEANUP_LABEL}.plist`)
  const expected = buildCleanupLaunchAgentConfig(options)
  async function seed(config: object | null = expected, content = "existing plist") {
    await mkdir(dirname(plistPath), { recursive: true })
    await Bun.write(plistPath, content)
    state.config = config
  }
  return { homeDir, commands, trashed, state, options, plistPath, expected, seed }
}

describe("daily cleanup LaunchAgent", () => {
  test("uses safe cleanup defaults, absolute arguments, logs, and the daily/on-load schedule", async () => {
    const f = await fixture()
    expect(f.expected.ProgramArguments).toEqual([
      f.options.bunPath!,
      "run",
      "/test/Swiz & tools/index.ts",
      "doctor",
      "clean",
    ])
    expect(f.expected.StartInterval).toBe(86400)
    expect(f.expected.RunAtLoad).toBe(true)
    expect(f.expected.ProcessType).toBe("Background")
    expect(f.expected).not.toHaveProperty("KeepAlive")
    expect(f.expected.EnvironmentVariables).toEqual({
      HOME: f.homeDir,
      PATH: expect.stringContaining("/usr/sbin"),
      SWIZ_DIRECT: "1",
    })
    expect(f.expected.EnvironmentVariables.PATH).toContain("/test/Bun & runtime")
    expect(f.expected.StandardOutPath).toBe(join(f.homeDir, "Library/Logs/Swiz/doctor-clean.log"))
    expect(f.expected.StandardErrorPath).toEndWith("doctor-clean.error.log")
  })

  test.skipIf(process.platform !== "darwin")(
    "round-trips escaped paths through native plutil",
    async () => {
      const f = await fixture()
      f.options.projectRoot = "/test/<Swiz> & \"friends' tools"
      await f.seed(null, buildCleanupLaunchAgentPlist(f.options))
      expect(await readLaunchAgentPlist(f.plistPath)).toEqual(
        buildCleanupLaunchAgentConfig(f.options)
      )
    }
  )

  test("installs and verifies registration after creating the log directory", async () => {
    const f = await fixture()
    expect(await installCleanupLaunchAgent(false, f.options)).toBe("install")
    expect(await Bun.file(f.plistPath).text()).toBe(buildCleanupLaunchAgentPlist(f.options))
    expect((await stat(dirname(f.expected.StandardOutPath))).isDirectory()).toBe(true)
    expect(f.commands.slice(-2)).toEqual([
      ["launchctl", "bootstrap", "gui/501", f.plistPath],
      ["launchctl", "print", `gui/501/${SWIZ_CLEANUP_LABEL}`],
    ])
    expect(await Bun.file(`${f.plistPath}.bak`).exists()).toBe(false)
  })

  test("does not reload equivalent plists with different dictionary ordering", async () => {
    const f = await fixture()
    await f.seed(Object.fromEntries(Object.entries(f.expected).reverse()))
    f.state.loaded = true
    expect(await installCleanupLaunchAgent(false, f.options)).toBe("unchanged")
    expect(await Bun.file(f.plistPath).text()).toBe("existing plist")
    expect(f.commands.map((c) => c[1])).toEqual(["-convert", "print"])
    expect(await Bun.file(`${f.plistPath}.bak`).exists()).toBe(false)
  })

  test("loads a current but unloaded job without rewriting its plist", async () => {
    const f = await fixture()
    await f.seed()
    expect(await installCleanupLaunchAgent(false, f.options)).toBe("load")
    expect(await Bun.file(f.plistPath).text()).toBe("existing plist")
    expect(f.commands.some((c) => c[1] === "bootout")).toBe(false)
  })

  test("backs up and reloads stale configuration", async () => {
    const f = await fixture()
    await f.seed({ ...f.expected, RunAtLoad: false })
    f.state.loaded = true
    expect(await installCleanupLaunchAgent(false, f.options)).toBe("reload")
    expect(await Bun.file(`${f.plistPath}.bak`).text()).toBe("existing plist")
    expect(f.commands.filter((c) => ["bootout", "bootstrap"].includes(c[1]!))).toEqual([
      ["launchctl", "bootout", `gui/501/${SWIZ_CLEANUP_LABEL}`],
      ["launchctl", "bootstrap", "gui/501", f.plistPath],
    ])
  })

  test.each(["missing", "stale", "unloaded"])("dry-run keeps %s state unchanged", async (kind) => {
    const f = await fixture()
    if (kind !== "missing") await f.seed(kind === "stale" ? { RunAtLoad: false } : f.expected)
    f.state.loaded = kind === "stale"
    await installCleanupLaunchAgent(true, f.options)
    expect(f.commands.every((c) => c[0] === "plutil" || c[1] === "print")).toBe(true)
    expect(await Bun.file(f.plistPath).exists()).toBe(kind !== "missing")
    expect(await Bun.file(`${f.plistPath}.bak`).exists()).toBe(false)
    expect(await stat(dirname(f.expected.StandardOutPath)).catch(() => null)).toBeNull()
  })

  test("failed unload preserves the old plist and never loads another job", async () => {
    const f = await fixture()
    await f.seed({ RunAtLoad: false })
    f.state.loaded = true
    f.state.unloadExit = 5
    await expect(installCleanupLaunchAgent(false, f.options)).rejects.toThrow("Could not unload")
    expect(await Bun.file(f.plistPath).text()).toBe("existing plist")
    expect(await Bun.file(`${f.plistPath}.bak`).exists()).toBe(false)
    expect(f.commands.some((c) => c[1] === "bootstrap")).toBe(false)
  })

  test.each(["failure", "not registered"])("reports a load %s", async (kind) => {
    const f = await fixture()
    f.state.loadExit = kind === "failure" ? 5 : 0
    f.state.registers = false
    await expect(installCleanupLaunchAgent(false, f.options)).rejects.toThrow("Could not load")
    expect(await Bun.file(f.plistPath).exists()).toBe(true)
  })

  test("uninstall unloads before trashing the plist and preserves logs", async () => {
    const f = await fixture()
    await f.seed()
    await Bun.write(f.expected.StandardOutPath, "cleanup log")
    f.state.loaded = true
    expect(await uninstallCleanupLaunchAgent(true, f.options)).toBe("remove")
    expect(f.trashed).toEqual([])
    expect(f.state.loaded).toBe(true)
    expect(await uninstallCleanupLaunchAgent(false, f.options)).toBe("remove")
    expect(f.state.loaded).toBe(false)
    expect(f.trashed).toEqual([f.plistPath])
    expect(await Bun.file(f.expected.StandardOutPath).text()).toBe("cleanup log")
  })

  test("failed uninstall does not trash a still-loaded job", async () => {
    const f = await fixture()
    await f.seed()
    f.state.loaded = true
    f.state.unloadExit = 5
    await expect(uninstallCleanupLaunchAgent(false, f.options)).rejects.toThrow("Could not unload")
    expect(f.trashed).toEqual([])
  })

  test("reports Trash failures instead of permanently deleting the plist", async () => {
    const f = await fixture()
    await f.seed()
    f.options.trashPath = async () => false
    await expect(uninstallCleanupLaunchAgent(false, f.options)).rejects.toThrow("to Trash")
    expect(await Bun.file(f.plistPath).exists()).toBe(true)
  })

  test("non-macOS installation and diagnostics perform no LaunchAgent work", async () => {
    const f = await fixture()
    f.options.platform = "linux"
    expect(await installCleanupLaunchAgent(false, f.options)).toBe("unsupported")
    expect(await uninstallCleanupLaunchAgent(false, f.options)).toBe("unsupported")
    expect((await checkCleanupLaunchAgent(f.options)).detail).toContain("not applicable")
    expect(f.commands).toEqual([])
    expect(await Bun.file(f.plistPath).exists()).toBe(false)
  })
})

describe("cleanup LaunchAgent diagnostics", () => {
  test("reports missing, stale, unloaded, and healthy jobs without changing them", async () => {
    const f = await fixture()
    expect(await checkCleanupLaunchAgent(f.options)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("not installed"),
    })
    await f.seed(null)
    expect((await checkCleanupLaunchAgent(f.options)).detail).toContain("outdated or invalid")
    f.state.config = f.expected
    expect((await checkCleanupLaunchAgent(f.options)).detail).toContain("not loaded")
    f.state.loaded = true
    expect(await checkCleanupLaunchAgent(f.options)).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("every 24 hours"),
    })
    expect(f.commands.every((c) => c[0] === "plutil" || c[1] === "print")).toBe(true)
  })

  test.each([
    { StartInterval: 3600 },
    { RunAtLoad: false },
    { KeepAlive: true },
    { ProgramArguments: ["bun", "doctor", "clean", "--force"] },
    { EnvironmentVariables: { SWIZ_DIRECT: "0" } },
    { StandardOutPath: "/tmp/old.log" },
  ])("detects unsafe or outdated fields: %j", async (overrides) => {
    const f = await fixture()
    await f.seed({ ...f.expected, ...overrides })
    f.state.loaded = true
    expect((await inspectCleanupLaunchAgent(f.options)).current).toBe(false)
    expect((await checkCleanupLaunchAgent(f.options)).status).toBe("warn")
  })
})

describe("default install integration", () => {
  async function runInstall(args: string[], f: Awaited<ReturnType<typeof fixture>>) {
    return runCommandInProcess(installCommand, args, {
      cwd: f.homeDir,
      env: { HOME: f.homeDir, SHELL: "/bin/zsh", AI_TEST_NO_BACKEND: "1" },
      commandOptions: {
        homeDir: f.homeDir,
        bunAvailable: () => true,
        cleanupAgentOptions: f.options,
      },
    })
  }

  test("default install registers daily cleanup", async () => {
    const f = await fixture()
    const result = await runInstall([], f)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Cleanup LaunchAgent: install")
    expect(f.state.loaded).toBe(true)
  })

  test("default dry-run previews cleanup without creating it", async () => {
    const f = await fixture()
    const result = await runInstall(["--dry-run"], f)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Cleanup LaunchAgent: would install")
    expect(await Bun.file(f.plistPath).exists()).toBe(false)
    expect(f.state.loaded).toBe(false)
  })

  test.each([
    { args: ["--codex"] },
    { args: ["--uninstall", "--codex"] },
    { args: ["--json"] },
    { args: ["--status-line", "--dry-run"] },
  ])("%j leaves user-wide cleanup untouched", async ({ args }) => {
    const f = await fixture()
    const result = await runInstall([...args], f)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("Cleanup LaunchAgent")
    expect(f.commands).toEqual([])
  })

  // The existing full uninstall also probes the macOS daemon outside our injected runtime.
  test.skipIf(process.platform !== "darwin")(
    "full uninstall dry-run includes cleanup removal",
    async () => {
      const f = await fixture()
      await f.seed()
      f.state.loaded = true
      const result = await runInstall(["--uninstall", "--dry-run"], f)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Cleanup LaunchAgent: would remove")
      expect(f.trashed).toEqual([])
      expect(f.state.loaded).toBe(true)
    }
  )
})
