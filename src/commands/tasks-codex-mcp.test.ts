import { describe, expect, test } from "bun:test"
import { mkdir, readdir, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  type InProcessCommandResult,
  neutralAgentEnv,
  neutralAgentEnvOverrides,
  runCommandInProcess,
  useTempDir,
} from "../utils/test-utils.ts"
import { tasksCommand } from "./tasks.ts"

const { create } = useTempDir("swiz-tasks-codex-mcp-")
const indexPath = resolve(import.meta.dir, "../../index.ts")
const enabledSwiz = '[mcp_servers.swiz]\ncommand = "swiz"\nargs = ["mcp"]\n'
const taskTools = ["TaskCreate", "TaskList", "TaskUpdate"]

async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, content)
}

async function fixture(globalConfig?: string, projectConfig?: string, trusted = true) {
  const root = await realpath(await create())
  const home = join(root, "home")
  const cwd = join(root, "workspace")
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const trustConfig =
    projectConfig !== undefined && trusted
      ? `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`
      : ""
  if (globalConfig !== undefined || trustConfig) {
    await writeConfig(join(home, ".codex", "config.toml"), `${globalConfig ?? ""}${trustConfig}`)
  }
  if (projectConfig !== undefined) {
    await writeConfig(join(cwd, ".codex", "config.toml"), projectConfig)
  }
  return {
    root,
    home,
    cwd,
    env: neutralAgentEnvOverrides({
      HOME: home,
      CODEX_HOME: undefined,
      CODEX_MANAGED_BY_NPM: "1",
      CODEX_THREAD_ID: "codex-mcp-guard-test",
      AI_TEST_NO_BACKEND: "1",
      SWIZ_DIRECT: "1",
    }),
  }
}

function expectMcpGuard(result: InProcessCommandResult): void {
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("Codex")
  expect(result.stderr).toContain("MCP")
  for (const tool of taskTools) expect(result.stderr).toContain(tool)
  expect(result.stdout).toBe("")
}

describe("Codex tasks CLI with Swiz MCP", () => {
  test.each([
    { label: "default list", args: [] },
    { label: "all sessions", args: ["--all-sessions"] },
    { label: "all projects", args: ["--all-projects"] },
    { label: "selected session", args: ["--session", "missing-session"] },
    { label: "recovered sessions", args: ["--recovered"] },
    { label: "date format", args: ["--date-format", "absolute"] },
    { label: "create", args: ["create", "Guard task", "Test description"] },
    { label: "create alias", args: ["TaskCreate", "Guard task", "Test description"] },
    { label: "update", args: ["update", "1", "--subject", "Changed subject"] },
    { label: "update alias", args: ["TaskUpdate", "1", "--status", "in_progress"] },
    { label: "completion alias", args: ["TaskUpdate", "1", "--status", "completed"] },
    { label: "status", args: ["status", "1", "in_progress"] },
    { label: "complete", args: ["complete", "1", "--evidence", "note:verified"] },
    { label: "completion dry run", args: ["complete", "1", "--dry-run"] },
  ])("blocks $label before resolving task data", async ({ args }) => {
    const context = await fixture(enabledSwiz)
    expectMcpGuard(await runCommandInProcess(tasksCommand, [...args], context))
  })

  test.each([
    { label: "explicitly enabled stdio", config: `${enabledSwiz}enabled = true\n` },
    {
      label: "remote transport",
      config: '[mcp_servers.swiz]\nurl = "https://example.invalid/mcp"\n',
    },
    {
      label: "all required tools explicitly enabled",
      config: `${enabledSwiz}enabled_tools = ${JSON.stringify(taskTools)}\n`,
    },
    {
      label: "unrelated disabled tool",
      config: `${enabledSwiz}disabled_tools = ["TaskGet"]\n`,
    },
  ])("recognizes $label", async ({ config }) => {
    const context = await fixture(config)
    expectMcpGuard(await runCommandInProcess(tasksCommand, ["--all-sessions"], context))
  })

  test.each([
    { label: "missing configuration", config: undefined },
    { label: "empty configuration", config: "" },
    { label: "unrelated settings", config: 'model = "test-model"\n' },
    { label: "unrelated MCP server", config: '[mcp_servers.other]\ncommand = "swiz"\n' },
    { label: "disabled Swiz server", config: `${enabledSwiz}enabled = false\n` },
    { label: "malformed TOML", config: '[mcp_servers.swiz\ncommand = "swiz"\n' },
    { label: "invalid server map", config: "mcp_servers = []\n" },
    { label: "invalid server value", config: "[mcp_servers]\nswiz = 1\n" },
    { label: "array server value", config: "[mcp_servers]\nswiz = []\n" },
    { label: "missing transport", config: "[mcp_servers.swiz]\nenabled = true\n" },
    { label: "empty command", config: '[mcp_servers.swiz]\ncommand = "  "\n' },
    { label: "invalid command", config: "[mcp_servers.swiz]\ncommand = 1\n" },
    { label: "empty URL", config: '[mcp_servers.swiz]\nurl = ""\n' },
    { label: "invalid enabled flag", config: `${enabledSwiz}enabled = "true"\n` },
    { label: "empty enabled tools", config: `${enabledSwiz}enabled_tools = []\n` },
    { label: "invalid enabled tools", config: `${enabledSwiz}enabled_tools = "TaskList"\n` },
    { label: "invalid disabled tools", config: `${enabledSwiz}disabled_tools = true\n` },
  ])("allows CLI fallback for $label", async ({ config }) => {
    const context = await fixture(config)
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
  })

  test.each(taskTools)("allows fallback when %s is missing from enabled tools", async (tool) => {
    const tools = taskTools.filter((candidate) => candidate !== tool)
    const context = await fixture(`${enabledSwiz}enabled_tools = ${JSON.stringify(tools)}\n`)
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test.each(taskTools)("allows fallback when %s is disabled", async (tool) => {
    const context = await fixture(
      `${enabledSwiz}enabled_tools = ${JSON.stringify(taskTools)}\ndisabled_tools = ["${tool}"]\n`
    )
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("reads the global configuration from CODEX_HOME", async () => {
    const context = await fixture()
    const codexHome = join(context.root, "custom-codex")
    await writeConfig(join(codexHome, "config.toml"), enabledSwiz)
    context.env.CODEX_HOME = codexHome
    expectMcpGuard(await runCommandInProcess(tasksCommand, ["--all-sessions"], context))
  })

  test("does not fall back to HOME configuration when CODEX_HOME is set", async () => {
    const context = await fixture(enabledSwiz)
    context.env.CODEX_HOME = join(context.root, "unconfigured-codex")
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("honors disabled Swiz configuration in CODEX_HOME over HOME", async () => {
    const context = await fixture(enabledSwiz)
    const codexHome = join(context.root, "custom-codex")
    await writeConfig(join(codexHome, "config.toml"), `${enabledSwiz}enabled = false\n`)
    context.env.CODEX_HOME = codexHome
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test.each([
    { label: "project-only installation", global: undefined, project: enabledSwiz, blocked: true },
    {
      label: "project disables global server",
      global: enabledSwiz,
      project: "[mcp_servers.swiz]\nenabled = false\n",
      blocked: false,
    },
    {
      label: "project enables inherited global transport",
      global: `${enabledSwiz}enabled = false\n`,
      project: "[mcp_servers.swiz]\nenabled = true\n",
      blocked: true,
    },
    {
      label: "unrelated project server preserves global Swiz",
      global: enabledSwiz,
      project: '[mcp_servers.other]\ncommand = "other"\n',
      blocked: true,
    },
    {
      label: "project disables an inherited task tool",
      global: enabledSwiz,
      project: '[mcp_servers.swiz]\ndisabled_tools = ["TaskUpdate"]\n',
      blocked: false,
    },
    {
      label: "project restores a globally disabled task tool",
      global: `${enabledSwiz}disabled_tools = ["TaskUpdate"]\n`,
      project: "[mcp_servers.swiz]\ndisabled_tools = []\n",
      blocked: true,
    },
    {
      label: "malformed project config allows fallback",
      global: enabledSwiz,
      project: "[mcp_servers.swiz]\ncommand = [\n",
      blocked: false,
    },
  ])("resolves $label", async ({ global, project, blocked }) => {
    const context = await fixture(global, project)
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    if (blocked) expectMcpGuard(result)
    else expect(result.exitCode).toBe(0)
  })

  test("ignores an untrusted project-only Swiz server", async () => {
    const context = await fixture(undefined, enabledSwiz, false)
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("ignores an untrusted project override disabling a global server", async () => {
    const context = await fixture(enabledSwiz, "[mcp_servers.swiz]\nenabled = false\n", false)
    expectMcpGuard(await runCommandInProcess(tasksCommand, ["--all-sessions"], context))
  })

  test("inherits trusted project configuration in a nested working directory", async () => {
    const context = await fixture(undefined, enabledSwiz)
    context.cwd = join(context.cwd, "packages", "app")
    await mkdir(context.cwd, { recursive: true })
    expectMcpGuard(await runCommandInProcess(tasksCommand, ["--all-sessions"], context))
  })

  test("applies nested project overrides after a trusted ancestor configuration", async () => {
    const context = await fixture(undefined, enabledSwiz)
    const packages = join(context.cwd, "packages")
    await writeConfig(
      join(packages, ".codex", "config.toml"),
      "[mcp_servers.swiz]\nenabled = false\n"
    )
    context.cwd = join(packages, "app")
    await mkdir(context.cwd, { recursive: true })
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("an explicit untrusted child overrides ancestor trust", async () => {
    const context = await fixture(undefined, enabledSwiz)
    const globalPath = join(context.home, ".codex", "config.toml")
    const globalConfig = await Bun.file(globalPath).text()
    context.cwd = join(context.cwd, "packages", "untrusted-app")
    await mkdir(context.cwd, { recursive: true })
    await writeConfig(
      globalPath,
      `${globalConfig}\n[projects.${JSON.stringify(context.cwd)}]\ntrust_level = "untrusted"\n`
    )
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("does not apply the Codex MCP guard to Gemini", async () => {
    const context = await fixture(enabledSwiz, enabledSwiz)
    context.env = neutralAgentEnvOverrides({ HOME: context.home, GEMINI_CLI: "1" })
    const result = await runCommandInProcess(tasksCommand, ["--all-sessions"], context)
    expect(result.exitCode).toBe(0)
  })

  test("permits scoped recovery when Codex has Swiz MCP without allowing task creation", async () => {
    const context = await fixture(enabledSwiz)
    const listing = await runCommandInProcess(tasksCommand, ["recover", "--all-sessions"], context)
    expect(listing.exitCode).toBe(0)
    expect(listing.stderr).toBe("")
    const creation = await runCommandInProcess(
      tasksCommand,
      ["recover", "create", "New task", "Not a recovery operation"],
      context
    )
    expect(creation.exitCode).toBe(1)
    expect(creation.stderr).toContain("Unsupported recovery command: create")
  })

  test("CLI exits nonzero before creating a task in an existing session", async () => {
    const context = await fixture()
    const codexHome = join(context.root, "custom-codex")
    await writeConfig(join(codexHome, "config.toml"), enabledSwiz)
    const sessionId = "codex-mcp-existing-session"
    const sessionDir = join(context.home, ".codex", "tasks", sessionId)
    await mkdir(sessionDir, { recursive: true })
    const proc = Bun.spawn(
      [
        process.execPath,
        indexPath,
        "tasks",
        "create",
        "Guard task",
        "Test description",
        "--session",
        sessionId,
      ],
      {
        cwd: context.cwd,
        env: neutralAgentEnv({ ...context.env, CODEX_HOME: codexHome }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expectMcpGuard({ stdout, stderr, exitCode: proc.exitCode ?? 0 })
    expect(await readdir(sessionDir)).toEqual([])
    const taskFiles = await Array.fromAsync(
      new Bun.Glob("**/tasks/**/*.json").scan({ cwd: context.root, dot: true })
    )
    expect(taskFiles).toEqual([])
  }, 15_000)
})
