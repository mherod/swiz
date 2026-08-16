import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
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
  async function runPackageManagerGuard(cwd: string, invoked: string, args: string[] = []) {
    return await runShell(
      ZSH_PATH ?? "zsh",
      [
        "-f",
        "-c",
        'source "$1"; invoked="$2"; shift 2; _swiz_pm_guard "$invoked" "$@"; guard_exit=$?; [[ "$guard_exit" -eq 1 ]]',
        "swiz",
        SHIM_PATH,
        invoked,
        ...args,
      ],
      { cwd, env: { SWIZ_SHIM: "strict" } }
    )
  }

  testWithZsh("respects an explicit npm package manager below a pnpm project", async () => {
    const parent = await tmp.create("swiz-shim-pm-parent-")
    const project = join(parent, "project")
    await mkdir(project)
    await Bun.write(join(parent, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await Bun.write(
      join(project, "package.json"),
      JSON.stringify({ name: "npm-project", packageManager: "npm@11.5.1" })
    )

    const result = await runPackageManagerGuard(project, "npm")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain("Do not use `npm`")
  })

  testWithZsh("allows npm when npm and pnpm lockfiles are both present", async () => {
    const project = await tmp.create("swiz-shim-pm-mixed-")
    await Bun.write(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await Bun.write(join(project, "package-lock.json"), "{}\n")

    const result = await runPackageManagerGuard(project, "npm")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain("Do not use `npm`")
  })

  testWithZsh("classifies npm --prefix commands from their target project", async () => {
    const parent = await tmp.create("swiz-shim-pm-prefix-")
    const project = join(parent, "project")
    await mkdir(project)
    await Bun.write(join(parent, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await Bun.write(join(project, "package-lock.json"), "{}\n")

    const result = await runPackageManagerGuard(parent, "npm", ["--prefix", project, "test"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain("Do not use `npm`")
  })

  testWithZsh("still blocks npm in an unambiguous pnpm project", async () => {
    const project = await tmp.create("swiz-shim-pm-pnpm-")
    await Bun.write(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")

    const result = await runPackageManagerGuard(project, "npm")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "swiz: Do not use `npm`. Project signals indicate `pnpm` is the expected package manager."
    )
  })

  testWithZsh("allows explicit global administration for each package manager", async () => {
    const bunProject = await tmp.create("swiz-shim-pm-global-bun-")
    const pnpmProject = await tmp.create("swiz-shim-pm-global-pnpm-")
    await Bun.write(join(bunProject, "bun.lock"), "")
    await Bun.write(join(pnpmProject, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")

    const cases = [
      { cwd: bunProject, invoked: "pnpm", args: ["list", "-g"] },
      { cwd: bunProject, invoked: "pnpm", args: ["list", "--global"] },
      { cwd: bunProject, invoked: "pnpm", args: ["config", "get", "globalconfig"] },
      { cwd: bunProject, invoked: "npm", args: ["config", "get", "prefix", "--location=global"] },
      { cwd: bunProject, invoked: "yarn", args: ["global", "list"] },
      { cwd: pnpmProject, invoked: "bun", args: ["pm", "bin", "-g"] },
    ]

    for (const entry of cases) {
      const result = await runPackageManagerGuard(entry.cwd, entry.invoked, entry.args)
      expect(result.exitCode, `${entry.invoked} ${entry.args.join(" ")}`).toBe(0)
      expect(result.stderr).not.toContain(`Do not use \`${entry.invoked}\``)
    }
  })

  testWithZsh("passes global administration arguments through unchanged", async () => {
    const bunProject = await tmp.create("swiz-shim-pm-passthrough-bun-")
    const pnpmProject = await tmp.create("swiz-shim-pm-passthrough-pnpm-")
    const binDir = await tmp.create("swiz-shim-pm-passthrough-bin-")
    await Bun.write(join(bunProject, "bun.lock"), "")
    await Bun.write(join(pnpmProject, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")

    const executablePaths = ["pnpm", "npm", "yarn", "bun"].map((name) => join(binDir, name))
    for (const executablePath of executablePaths) {
      await Bun.write(executablePath, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    }
    const chmod = Bun.spawn(["chmod", "+x", ...executablePaths], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [, chmodStderr, chmodExitCode] = await Promise.all([
      new Response(chmod.stdout).text(),
      new Response(chmod.stderr).text(),
      chmod.exited,
    ])
    expect(chmodExitCode, chmodStderr).toBe(0)

    const cases = [
      { cwd: bunProject, invoked: "pnpm", args: ["list", "--global"] },
      { cwd: bunProject, invoked: "npm", args: ["config", "get", "prefix", "--location=global"] },
      { cwd: bunProject, invoked: "yarn", args: ["global", "list"] },
      { cwd: pnpmProject, invoked: "bun", args: ["pm", "bin", "-g"] },
    ]

    for (const entry of cases) {
      const result = await runShell(
        ZSH_PATH ?? "zsh",
        [
          "-f",
          "-c",
          'source "$1"; invoked="$2"; shift 2; "$invoked" "$@"',
          "swiz",
          SHIM_PATH,
          entry.invoked,
          ...entry.args,
        ],
        {
          cwd: entry.cwd,
          env: { PATH: `${binDir}:${process.env.PATH}`, SWIZ_SHIM: "strict" },
        }
      )
      expect(result.exitCode, `${entry.invoked} ${entry.args.join(" ")}`).toBe(0)
      expect(result.stdout).toBe(`${entry.args.join("\n")}\n`)
      expect(result.stderr).not.toContain(`Do not use \`${entry.invoked}\``)
    }
  })

  testWithZsh("keeps project-scoped commands and inert global text guarded", async () => {
    const project = await tmp.create("swiz-shim-pm-global-negative-")
    await Bun.write(join(project, "bun.lock"), "")

    const cases = [
      ["pnpm", ["install"]],
      ["pnpm", ["run", "build", "-g"]],
      ["pnpm", ["run", "global"]],
      ["pnpm", ["add", "global-tool"]],
      ["pnpm", ["list", "--", "--global"]],
      ["pnpm", ["config", "get", "nodeVersion", "--location=project"]],
      ["npm", ["config", "get", "prefix"]],
      ["yarn", ["run", "global"]],
    ] as const

    for (const [invoked, args] of cases) {
      const result = await runPackageManagerGuard(project, invoked, [...args])
      expect(result.exitCode, `${invoked} ${args.join(" ")}`).toBe(1)
      expect(result.stderr).toContain(`Do not use \`${invoked}\``)
    }
  })

  testWithZsh("finds Bun before login PATH setup runs", async () => {
    const home = await tmp.create("swiz-shim-home-bun-path-")
    const bunInstall = join(home, ".bun")
    const bunBinDir = join(bunInstall, "bin")
    const bunPath = join(bunBinDir, "bun")
    await mkdir(bunBinDir, { recursive: true })
    await Bun.write(bunPath, "#!/usr/bin/env sh\nprintf 'fake-bun\\n'\n")
    const chmod = Bun.spawn(["chmod", "+x", bunPath], { stdout: "pipe", stderr: "pipe" })
    const [, , chmodExitCode] = await Promise.all([
      new Response(chmod.stdout).text(),
      new Response(chmod.stderr).text(),
      chmod.exited,
    ])
    expect(chmodExitCode).toBe(0)

    const result = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; command bun', "swiz", SHIM_PATH],
      {
        cwd: home,
        env: {
          BUN_INSTALL: bunInstall,
          HOME: home,
          PATH: "/usr/bin:/bin",
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("fake-bun\n")
    expect(result.stderr).not.toContain("bun is not installed or not on PATH")
  })

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

  testWithZsh(
    "allows git restore on empty or missing files while blocking populated files",
    async () => {
      const repo = await makeTempGitRepo(tmp, { suffix: "-restore" })
      const emptyFile = join(repo, "empty.txt")
      const populatedFile = join(repo, "populated.txt")
      await Bun.write(emptyFile, "")
      await Bun.write(populatedFile, "cannot delete\n")

      const emptyResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore empty.txt', "swiz", SHIM_PATH],
        { cwd: repo, env: { SWIZ_SHIM: "strict" } }
      )
      expect(emptyResult.stderr).not.toContain("Do not use `git restore`")

      const missingResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore non-existent.txt', "swiz", SHIM_PATH],
        { cwd: repo, env: { SWIZ_SHIM: "strict" } }
      )
      expect(missingResult.stderr).not.toContain("Do not use `git restore`")

      const populatedResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore populated.txt', "swiz", SHIM_PATH],
        { cwd: repo, env: { SWIZ_SHIM: "strict" } }
      )
      expect(populatedResult.exitCode).toBe(1)
      expect(populatedResult.stderr).toContain("swiz: Do not use `git restore`")
    }
  )

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

  testWithZsh(
    "sources cleanly even when pre-existing aliases exist for shimmed commands",
    async () => {
      const result = await runShell(
        ZSH_PATH ?? "zsh",
        [
          "-f",
          "-c",
          'alias unalias="echo fake"; alias grep="grep --color=auto"; alias cd="cd -P"; alias git="hub"; source "$1"; grep --version >/dev/null 2>&1 || true',
          "swiz",
          SHIM_PATH,
        ],
        { env: { SWIZ_SHIM: "strict" } }
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain("defining function based on alias")
      expect(result.stderr).not.toContain("parse error near")
    }
  )
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
