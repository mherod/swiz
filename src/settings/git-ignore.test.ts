import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BunGitClient, withGitClient } from "../git/client"
import { MockGitClient } from "../git/mock-client"
import { useTempDir } from "../utils/test-utils"
import { ensureProjectSettingsIgnored } from "./git-ignore"
import { writeProjectSettings } from "./persistence"

const temporary = useTempDir("swiz-settings-ignore-")

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

test("settings writes exclude and ignore config and backup without duplicate rules", async () => {
  const cwd = await temporary.create()
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
  const cwd = await temporary.create()
  await writeProjectSettings(cwd, { autoContinue: true })
  expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
})

test("tracked settings are removed from the index while preserving local values", async () => {
  const cwd = await temporary.create()
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
  const cwd = await temporary.create()
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

test.each([
  false,
  true,
])("ignored settings preserve a locked index (linked: %p)", async (linked) => {
  const root = await temporary.create()
  runGit(root, "init")
  let cwd = root
  if (linked) {
    runGit(
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "init"
    )
    cwd = join(root, "linked")
    runGit(root, "worktree", "add", "-b", "linked", cwd)
  }
  await writeProjectSettings(cwd, { autoContinue: true })
  await Bun.write(join(cwd, "unrelated.txt"), "staged work\n")
  runGit(cwd, "add", "unrelated.txt")
  const index = resolve(cwd, runGit(cwd, "rev-parse", "--git-path", "index"))
  const lock = `${index}.lock`
  await Bun.write(lock, "fixture-owned lock\n")
  const paths = [
    index,
    lock,
    join(cwd, ".gitignore"),
    resolve(cwd, runGit(cwd, "rev-parse", "--git-path", "info/exclude")),
  ]
  const before = await Promise.all(paths.map((path) => Bun.file(path).bytes()))

  await writeProjectSettings(cwd, { autoContinue: false })

  expect(await Promise.all(paths.map((path) => Bun.file(path).bytes()))).toEqual(before)
  expect(await Bun.file(join(cwd, ".swiz/config.json")).json()).toEqual({ autoContinue: false })
  expect(await Bun.file(join(cwd, ".swiz/config.json.bak")).json()).toEqual({ autoContinue: true })
})

test.each([
  "config.json",
  "config.json.bak",
  "both",
])("safely untracks %s without changing local contents", async (tracked) => {
  const cwd = await temporary.create()
  runGit(cwd, "init")
  const names = tracked === "both" ? ["config.json", "config.json.bak"] : [tracked]
  const paths = names.map((name) => `.swiz/${name}`)
  for (const path of paths) await Bun.write(join(cwd, path), `local value for ${path}\n`)
  await Bun.write(join(cwd, "unrelated.txt"), "keep staged\n")
  runGit(cwd, "add", ...paths, "unrelated.txt")
  await ensureProjectSettingsIgnored(cwd)
  expect(runGit(cwd, "ls-files")).toBe("unrelated.txt")
  for (const path of paths)
    expect(await Bun.file(join(cwd, path)).text()).toBe(`local value for ${path}\n`)
})

test.each([
  "lock",
  "staged",
])("reports the actual %s conflict without changing config or index", async (conflict) => {
  const cwd = await temporary.create()
  runGit(cwd, "init")
  const config = join(cwd, ".swiz/config.json")
  await Bun.write(config, '{"autoContinue":true}')
  runGit(cwd, "add", ".swiz/config.json")
  const lock = join(cwd, ".git/index.lock")
  if (conflict === "lock") await Bun.write(lock, "fixture-owned lock\n")
  else await Bun.write(config, '{"autoContinue":false}')
  const paths = [config, join(cwd, ".git/index"), ...(conflict === "lock" ? [lock] : [])]
  const before = await Promise.all(paths.map((path) => Bun.file(path).bytes()))
  const error = await writeProjectSettings(cwd, { autoContinue: true }).catch(
    (error: Error) => error
  )
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain(conflict === "lock" ? "index.lock" : "staged content")
  expect(String(error)).toContain(conflict === "lock" ? "Wait for" : "Review")
  expect(String(error)).not.toContain("use -f")
  expect(await Promise.all(paths.map((path) => Bun.file(path).bytes()))).toEqual(before)
})

test("corrupt index queries fail before ignore rules or settings change", async () => {
  const cwd = await temporary.create()
  runGit(cwd, "init")
  await Bun.write(join(cwd, ".git/index"), "invalid index")
  const exclude = await Bun.file(join(cwd, ".git/info/exclude")).text()
  await expect(writeProjectSettings(cwd, { autoContinue: true })).rejects.toThrow(
    "index file smaller than expected"
  )
  expect(await Bun.file(join(cwd, ".git/index")).text()).toBe("invalid index")
  expect(await Bun.file(join(cwd, ".git/info/exclude")).text()).toBe(exclude)
  expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
  expect(await Bun.file(join(cwd, ".swiz/config.json")).exists()).toBe(false)
})

test.each([
  "--show-toplevel",
  "--git-path",
  "ls-files",
  "rm",
  "spawn",
])("preserves permission errors from %s", async (failure) => {
  const cwd = await temporary.create()
  runGit(cwd, "init")
  await Bun.write(join(cwd, ".swiz/config.json"), '{"autoContinue":true}')
  runGit(cwd, "add", ".swiz/config.json")
  const real = new BunGitClient()
  const client = new MockGitClient((args, options) => {
    if (failure === "spawn") throw new Error("spawn git: EACCES permission denied")
    if (args.includes(failure))
      return { exitCode: 128, stderr: "fatal: Permission denied opening Git metadata" }
    return real.runSync(args, options)
  })
  const error = await withGitClient(client, () =>
    writeProjectSettings(cwd, { autoContinue: false })
  ).catch((error: Error) => error)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toMatch(/permission denied/i)
  expect(String(error)).toContain("permissions")
  expect(String(error)).not.toContain("resolve staged changes")
  expect(await Bun.file(join(cwd, ".swiz/config.json")).json()).toEqual({ autoContinue: true })
  expect(runGit(cwd, "ls-files")).toBe(".swiz/config.json")
  if (failure !== "rm") expect(client.calls.some((call) => call.args[0] === "rm")).toBe(false)
})

test("exit one from a tracked-path query is not an empty successful result", async () => {
  const cwd = await temporary.create()
  runGit(cwd, "init")
  const real = new BunGitClient()
  const client = new MockGitClient((args, options) =>
    args[0] === "ls-files" ? { exitCode: 1, stderr: "query failed" } : real.runSync(args, options)
  )
  await expect(withGitClient(client, () => ensureProjectSettingsIgnored(cwd))).rejects.toThrow(
    "query failed"
  )
  expect(client.calls.some((call) => call.args[0] === "rm")).toBe(false)
  expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
})
