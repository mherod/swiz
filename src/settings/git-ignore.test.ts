import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeProjectSettings } from "./persistence"

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

test("settings writes exclude and ignore config and backup without duplicate rules", async () => {
  const cwd = join(tmpdir(), `swiz-settings-ignore-${crypto.randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  runGit(cwd, "init")
  await Bun.write(join(cwd, ".gitignore"), "*.log")
  await writeProjectSettings(cwd, { autoContinue: true })
  await writeProjectSettings(cwd, { autoContinue: false })
  const ignored = runGit(cwd, "check-ignore", ".swiz/config.json", ".swiz/config.json.bak")
  expect(ignored.split("\n")).toEqual([".swiz/config.json", ".swiz/config.json.bak"])
  expect(await Bun.file(join(cwd, ".gitignore")).text()).toBe(
    "*.log\n/.swiz/config.json\n/.swiz/config.json.bak\n"
  )
  expect(await Bun.file(join(cwd, ".git/info/exclude")).text()).toContain(".swiz/config.json\n")
  expect(await Bun.file(join(cwd, ".swiz/config.json.bak")).json()).toEqual({ autoContinue: true })
})

test("settings outside Git do not create ignore files", async () => {
  const cwd = join(tmpdir(), `swiz-settings-no-git-${crypto.randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  await writeProjectSettings(cwd, { autoContinue: true })
  expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
})

test("tracked settings are removed from the index while preserving local values", async () => {
  const cwd = join(tmpdir(), `swiz-settings-tracked-${crypto.randomUUID()}`)
  await mkdir(join(cwd, ".swiz"), { recursive: true })
  runGit(cwd, "init")
  await Bun.write(join(cwd, ".swiz/config.json"), '{"autoContinue":true}')
  runGit(cwd, "add", ".swiz/config.json")
  await writeProjectSettings(cwd, { autoContinue: false })
  expect(runGit(cwd, "ls-files", ".swiz/config.json")).toBe("")
  expect(await Bun.file(join(cwd, ".swiz/config.json")).json()).toEqual({ autoContinue: false })
  expect(runGit(cwd, "check-ignore", ".swiz/config.json")).toBe(".swiz/config.json")
})

test("linked worktrees use the shared exclude file", async () => {
  const cwd = join(tmpdir(), `swiz-settings-worktree-${crypto.randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  runGit(cwd, "init")
  runGit(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "init"
  )
  const worktree = join(cwd, "linked")
  runGit(cwd, "worktree", "add", "-b", "linked", worktree)
  await writeProjectSettings(worktree, { autoContinue: true })
  expect(await Bun.file(join(cwd, ".git/info/exclude")).text()).toContain(".swiz/config.json\n")
  expect(runGit(worktree, "check-ignore", ".swiz/config.json")).toBe(".swiz/config.json")
})
