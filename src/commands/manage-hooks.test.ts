import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { inspectCodexHookSources } from "../codex-hook-config.ts"
import { withGitClient } from "../git/client.ts"
import { MockGitClient } from "../git/mock-client.ts"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { checkCodexHookSources } from "./doctor/checks/codex-hook-sources.ts"
import { doctorCommand } from "./doctor.ts"
import { manageCommand } from "./manage.ts"

const temp = useTempDir("manage-hook-repair-")
async function fixture() {
  const home = await temp.create()
  const directory = join(home, ".codex")
  await mkdir(directory)
  await Bun.write(
    join(directory, "hooks.json"),
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing"}]}]}}'
  )
  await Bun.write(
    join(directory, "config.toml"),
    '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype="command"\ncommand="custom"\n'
  )
  return { home, directory }
}

test("manage exposes validation, dry run, repair, and idempotent validation", async () => {
  const { home, directory } = await fixture()
  const options = { cwd: home, commandOptions: { home, cwd: home } }
  const invalid = await runCommandInProcess(
    manageCommand,
    ["hooks", "validate", "--codex"],
    options
  )
  expect(invalid.exitCode).not.toBe(0)
  expect(invalid.stderr).toContain("swiz manage hooks repair --codex")
  const preview = await runCommandInProcess(
    manageCommand,
    ["hooks", "repair", "--codex", "--dry-run"],
    options
  )
  expect(preview.stdout).toContain("Would move 1")
  expect((await inspectCodexHookSources(directory)).conflict).toBe(true)
  const fixed = await runCommandInProcess(manageCommand, ["hooks", "repair", "--codex"], options)
  expect(fixed.exitCode).toBe(0)
  expect(fixed.stdout).toContain("Moved 1")
  expect(
    (await runCommandInProcess(manageCommand, ["hooks", "validate", "--codex"], options)).exitCode
  ).toBe(0)
})

test("project repair never changes the home layer", async () => {
  const global = await fixture()
  const project = await fixture()
  const result = await runCommandInProcess(
    manageCommand,
    ["hooks", "repair", "--codex", "--project"],
    { commandOptions: { home: global.home, cwd: project.home } }
  )
  expect(result.exitCode).toBe(0)
  expect((await inspectCodexHookSources(global.directory)).conflict).toBe(true)
  expect((await inspectCodexHookSources(project.directory)).conflict).toBe(false)
})

test("doctor reports the conflict and --fix uses the same preserving repair", async () => {
  const { home, directory } = await fixture()
  const git = new MockGitClient()
  const options = {
    cwd: home,
    env: { HOME: home, AI_TEST_NO_BACKEND: "1" },
    commandOptions: {
      allChecks: [{ name: "codex-hook-sources", run: () => checkCodexHookSources(directory) }],
      autoCleanup: () => Promise.resolve(),
      fixStaleConfigs: () => Promise.resolve(),
      notifyDaemon: () => Promise.resolve(),
    },
  }
  const report = await withGitClient(git, () => runCommandInProcess(doctorCommand, [], options))
  expect(report.stdout).toContain("swiz manage hooks repair --codex")
  expect((await inspectCodexHookSources(directory)).conflict).toBe(true)
  const fixed = await withGitClient(git, () =>
    runCommandInProcess(doctorCommand, ["--fix"], options)
  )
  expect(fixed.exitCode).toBe(0)
  expect(fixed.stdout).toContain("Consolidated 1")
  expect((await inspectCodexHookSources(directory)).conflict).toBe(false)
  expect(git.calls).toHaveLength(0)
})

test("rejects unsupported repair flags without changing files", async () => {
  const { home, directory } = await fixture()
  const result = await runCommandInProcess(manageCommand, ["hooks", "repair", "--cursor"], {
    commandOptions: { home },
  })
  expect(result.exitCode).not.toBe(0)
  expect((await inspectCodexHookSources(directory)).conflict).toBe(true)
})
