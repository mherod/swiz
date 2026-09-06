import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../agents.ts"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { settingsCommand } from "./settings.ts"

const temporary = useTempDir("swiz-settings-forgiving-")
const agentEnvKeys = [
  ...new Set([...AGENTS.flatMap((agent) => agent.envVars ?? []), "CURSOR_TRACE_ID"]),
]

async function fixture(repo = true) {
  const home = await realpath(await temporary.create())
  const cwd = join(home, "website")
  await mkdir(repo ? join(cwd, ".git") : cwd, { recursive: true })
  return { home, cwd }
}

async function runSettings(
  args: string[],
  context: { home: string; cwd: string },
  agentEnv: Record<string, string> = {}
) {
  return runCommandInProcess(settingsCommand, args, {
    cwd: context.cwd,
    env: {
      ...Object.fromEntries(agentEnvKeys.map((key) => [key, undefined])),
      HOME: context.home,
      AI_TEST_NO_BACKEND: "1",
      ...agentEnv,
    },
    commandOptions: { daemonReady: async () => false },
  })
}

async function expectNoWrites(context: { home: string; cwd: string }) {
  expect(await Bun.file(join(context.cwd, ".swiz/config.json")).exists()).toBe(false)
  expect(await Bun.file(join(context.home, ".swiz/settings.json")).exists()).toBe(false)
}

describe("settings outside agent environments", () => {
  test("the reported collab-mode command writes project settings", async () => {
    const context = await fixture()
    const result = await runSettings(["set", "collab-mode", "solo"], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set collab-mode = solo (project)")
    expect(result.stdout).toContain(join(context.cwd, ".swiz/config.json"))
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toMatchObject({
      collaborationMode: "solo",
    })
    expect(await Bun.file(join(context.home, ".swiz/settings.json")).exists()).toBe(false)
  })

  test("nested directories use the repository root", async () => {
    const context = await fixture()
    const nested = join(context.cwd, "src/components")
    await mkdir(nested, { recursive: true })
    const result = await runSettings(["set", "collab-mode", "solo", "--json"], {
      ...context,
      cwd: nested,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      setting: "collaborationMode",
      value: "solo",
      scope: "project",
      path: join(context.cwd, ".swiz/config.json"),
    })
    expect(await Bun.file(join(nested, ".swiz/config.json")).exists()).toBe(false)
    const shown = await runSettings(["show", "--json"], { ...context, cwd: nested })
    expect(shown.exitCode).toBe(0)
    expect(JSON.parse(shown.stdout).collaborationMode).toBe("solo")
  })

  test("Git worktrees with a .git file use project scope", async () => {
    const context = await fixture(false)
    await Bun.write(join(context.cwd, ".git"), `gitdir: ${join(context.home, "git-worktree")}\n`)
    const result = await runSettings(["set", "collab-mode", "team"], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("(project)")
  })

  test("outside a repository the same command writes global settings", async () => {
    const context = await fixture(false)
    const result = await runSettings(["set", "collab-mode", "solo", "--json"], context)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).scope).toBe("global")
    expect(await Bun.file(join(context.home, ".swiz/settings.json")).json()).toMatchObject({
      collaborationMode: "solo",
      sessions: {},
    })
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).exists()).toBe(false)
  })

  test("--dir selects the exact project directory even outside Git", async () => {
    const context = await fixture()
    const target = join(context.home, "other-site")
    await mkdir(target)
    const result = await runSettings(["set", "collab", "team", "--dir", "../other-site"], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(join(target, ".swiz/config.json"))
    expect(await Bun.file(join(target, ".swiz/config.json")).json()).toMatchObject({
      collaborationMode: "team",
    })
    await expectNoWrites(context)
  })

  test.each([
    "--global",
    "-g",
    "--user",
    "-u",
  ])("%s overrides inferred project scope", async (flag) => {
    const context = await fixture()
    const result = await runSettings(["set", "collab-mode", "solo", flag], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("(global)")
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).exists()).toBe(false)
  })

  test.each(["--project", "-p"])("%s overrides inferred global scope", async (flag) => {
    const context = await fixture(false)
    const result = await runSettings(["set", "collab-mode", "solo", flag], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("(project)")
    expect(await Bun.file(join(context.home, ".swiz/settings.json")).exists()).toBe(false)
  })

  test("settings without project support fall back to global, never session", async () => {
    const context = await fixture()
    for (const args of [
      ["set", "narrator-speed", "180"],
      ["disable", "pr-merge-mode"],
    ]) {
      const result = await runSettings([...args, "--json"], context)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout).scope).toBe("global")
    }
    expect(await Bun.file(join(context.home, ".swiz/settings.json")).json()).toMatchObject({
      narratorSpeed: 180,
      prMergeMode: false,
      sessions: {},
    })
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).exists()).toBe(false)
  })

  test("project-only settings infer project scope", async () => {
    const context = await fixture(false)
    const result = await runSettings(["enable", "trunk-mode"], context)
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toMatchObject({
      trunkMode: true,
    })
  })

  test("explicit unsupported scope is rejected", async () => {
    const context = await fixture()
    const result = await runSettings(["set", "narrator-speed", "180", "--project"], context)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not support --project")
    await expectNoWrites(context)
  })

  test("show needs no scope and does not create config", async () => {
    const context = await fixture(false)
    const result = await runSettings(["--json"], context)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).collaborationMode).toBe("auto")
    await expectNoWrites(context)
  })

  test("hook commands infer project scope and preserve backups", async () => {
    const context = await fixture()
    const disabled = await runSettings(["disable-hook", "stop-ship-checklist.ts"], context)
    expect(disabled.exitCode).toBe(0)
    expect(disabled.stdout).toContain("(project)")
    const enabled = await runSettings(["enable-hook", "stop-ship-checklist.ts"], context)
    expect(enabled.exitCode).toBe(0)
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toMatchObject({
      disabledHooks: [],
    })
    expect(await Bun.file(join(context.cwd, ".swiz/config.json.bak")).json()).toMatchObject({
      disabledHooks: ["stop-ship-checklist.ts"],
    })
  })

  test.each([
    "true",
    " ON ",
    "yes",
    "1",
    "enabled",
    "false",
    "OFF",
    "no",
    "0",
    "disabled",
  ])("set accepts boolean value %s", async (value) => {
    const context = await fixture()
    const expected = ["true", "on", "yes", "1", "enabled"].includes(value.trim().toLowerCase())
    const result = await runSettings(["set", "auto-continue", value, "--json"], context)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ value: expected, scope: "project" })
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toMatchObject({
      autoContinue: expected,
    })
  })

  test("boolean set still enforces conflicts", async () => {
    const context = await fixture()
    await Bun.write(
      join(context.cwd, ".swiz/config.json"),
      JSON.stringify({ strictNoDirectMain: true })
    )
    const result = await runSettings(["set", "trunk-mode", "on"], context)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Cannot enable trunk-mode")
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toEqual({
      strictNoDirectMain: true,
    })
  })

  test("enum values ignore case and surrounding spaces", async () => {
    const context = await fixture()
    const result = await runSettings(["set", "COLLAB-MODE", " Solo "], context)
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(join(context.cwd, ".swiz/config.json")).json()).toMatchObject({
      collaborationMode: "solo",
    })
  })

  test.each(["Feature/Main", ""])("free-form strings retain their value: %s", async (value) => {
    const context = await fixture()
    const setting = value ? "default-branch" : "narrator-voice"
    const result = await runSettings(["set", setting, value, "--json"], context)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).value).toBe(value)
  })

  test("unknown settings get a short suggestion without writing", async () => {
    const context = await fixture()
    const result = await runSettings(["set", "collb-mode", "solo"], context)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('did you mean: "collab-mode"')
    expect(result.stderr).not.toContain("Settings (--global)")
    await expectNoWrites(context)
  })

  test.each(
    [
      ["set", "collab-mode", "solo", "--globla"],
      ["set", "collab-mode", "solo", "extra"],
      ["set", "collab-mode", "solo", "--global", "--project"],
      ["set", "auto-continue", "maybe"],
    ].map((args) => ({ args }))
  )("rejects invalid arguments without writing: %j", async ({ args }) => {
    const context = await fixture()
    const result = await runSettings(args, context)
    expect(result.exitCode).toBe(1)
    await expectNoWrites(context)
  })
})

describe("settings in agent environments", () => {
  test.each(agentEnvKeys)("%s requires an explicit scope", async (key) => {
    const context = await fixture()
    const agentEnv = { [key]: "1" }
    for (const args of [
      ["set", "collab-mode", "solo"],
      ["show"],
      ["enable", "auto-continue"],
      ["disable-hook", "stop-ship-checklist.ts"],
    ]) {
      const result = await runSettings(args, context, agentEnv)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Scope is required")
    }
    await expectNoWrites(context)
    const explicit = await runSettings(
      ["set", "collab-mode", "solo", "--project"],
      context,
      agentEnv
    )
    expect(explicit.exitCode).toBe(0)
  })

  test("agent values retain strict validation", async () => {
    const context = await fixture()
    for (const args of [
      ["set", "collab-mode", "SOLO"],
      ["set", "auto-continue", "on"],
    ]) {
      const result = await runSettings([...args, "--project"], context, {
        CODEX_THREAD_ID: "test-thread",
      })
      expect(result.exitCode).toBe(1)
    }
    await expectNoWrites(context)
  })
})
