import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { makeTempGitRepo, useTempDir } from "../utils/test-utils.ts"
import {
  ensureShimInstallation,
  inspectShimInstallation,
  uninstallShimInstallation,
} from "./shim.ts"

const SHIM_PATH = resolve(import.meta.dir, "../../hooks/shim.sh")
const tmp = useTempDir("swiz-shim-")
const ZSH_PATH = Bun.which("zsh")
const testWithZsh = ZSH_PATH ? test : test.skip

async function runShell(
  shell: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([shell, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("shell shim runtime", () => {
  testWithZsh("git wrapper runs under zsh and still blocks an unsafe force push", async () => {
    const repo = await makeTempGitRepo(tmp, { suffix: "-zsh" })
    const status = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; git -C "$2" status --short', "swiz", SHIM_PATH, repo],
      { cwd: repo, env: { SWIZ_SHIM: "strict" } }
    )
    expect(status.exitCode).toBe(0)
    expect(status.stderr).not.toContain("bad substitution")

    const forcePush = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; git push --force origin main', "swiz", SHIM_PATH],
      { cwd: repo, env: { SWIZ_SHIM: "strict" } }
    )
    expect(forcePush.exitCode).toBe(1)
    expect(forcePush.stderr).toContain("git push --force is blocked")
  })

  testWithZsh("allows read-only sed while blocking in-place edits", async () => {
    const dir = await tmp.create("swiz-shim-sed-")
    const input = join(dir, "input.txt")
    await Bun.write(input, "first\nsecond\n")

    const readOnly = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; sed -n "1p" "$2"', "swiz", SHIM_PATH, input],
      { cwd: dir, env: { SWIZ_SHIM: "strict" } }
    )
    expect(readOnly.exitCode).toBe(0)
    expect(readOnly.stdout).toBe("first\n")

    const inPlace = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; sed -i "" "s/first/changed/" "$2"', "swiz", SHIM_PATH, input],
      { cwd: dir, env: { SWIZ_SHIM: "strict" } }
    )
    expect(inPlace.exitCode).toBe(1)
    expect(inPlace.stderr).toContain("In-place sed edits are blocked")
    expect(await Bun.file(input).text()).toBe("first\nsecond\n")
  })

  test("does not remove an existing Git index lock", async () => {
    const repo = await makeTempGitRepo(tmp, { suffix: "-lock" })
    const lockPath = join(repo, ".git", "index.lock")
    await Bun.write(lockPath, "owned elsewhere\n")

    const result = await runShell(
      "/bin/bash",
      ["-c", 'source "$1"; git status --short', "swiz", SHIM_PATH],
      { cwd: repo, env: { SWIZ_SHIM: "strict" } }
    )
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(lockPath).exists()).toBe(true)
    expect(await Bun.file(lockPath).text()).toBe("owned elsewhere\n")
  })
})

describe("shell shim installation", () => {
  test("installs idempotently and backs up an existing zsh profile", async () => {
    const home = await tmp.create("swiz-shim-home-zsh-")
    const profile = join(home, ".zshenv")
    await Bun.write(profile, "export KEEP_ME=1\n")

    const first = await ensureShimInstallation({ home, shell: "/bin/zsh", shimPath: SHIM_PATH })
    expect(first.changedProfiles).toEqual([profile])
    expect(await Bun.file(`${profile}.bak`).text()).toBe("export KEEP_ME=1\n")

    const second = await ensureShimInstallation({ home, shell: "/bin/zsh", shimPath: SHIM_PATH })
    expect(second.changedProfiles).toEqual([])
    const status = await inspectShimInstallation({ home, shell: "/bin/zsh", shimPath: SHIM_PATH })
    expect(status.healthy).toBe(true)
    expect(await Bun.file(profile).text()).toContain("export KEEP_ME=1")
  })

  test("covers interactive and non-interactive bash end to end", async () => {
    const home = await tmp.create("swiz-shim-home-bash-")
    const input = join(home, "input.txt")
    await Bun.write(input, "needle\n")
    await ensureShimInstallation({ home, shell: "/bin/bash", shimPath: SHIM_PATH })

    const result = await runShell(
      "/bin/bash",
      ["-l", "-c", 'bash -c \'grep needle "$1"\' swiz "$1"', "swiz", input],
      { env: { HOME: home, SHELL: "/bin/bash", SWIZ_SHIM: "strict" } }
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Do not use `grep`")
    expect(await Bun.file(join(home, ".bashrc")).text()).toContain("swiz shim")
    expect(await Bun.file(join(home, ".bash_profile")).text()).toContain("BASH_ENV")
  })

  test("uninstalls from every supported profile regardless of current shell", async () => {
    const home = await tmp.create("swiz-shim-home-uninstall-")
    await ensureShimInstallation({ home, shell: "/bin/zsh", shimPath: SHIM_PATH })
    await ensureShimInstallation({ home, shell: "/bin/bash", shimPath: SHIM_PATH })

    const result = await uninstallShimInstallation({ home })
    expect(result.changedProfiles.map((path) => path.slice(home.length + 1)).sort()).toEqual([
      ".bash_profile",
      ".bashrc",
      ".zshenv",
    ])
    for (const name of [".zshenv", ".bashrc", ".bash_profile"]) {
      expect(await Bun.file(join(home, name)).text()).not.toContain("swiz shim")
    }
  })
})
