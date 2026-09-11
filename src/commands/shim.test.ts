import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { evaluatePretooluseBannedCommands } from "../../hooks/pretooluse-banned-commands.ts"
import noNpmHook from "../../hooks/pretooluse-no-npm.ts"
import { quotePosixShellArg } from "../utils/shell-patterns.ts"
import { useTempDir } from "../utils/test-utils.ts"
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

async function writeExecutable(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents)
  const chmod = Bun.spawn(["chmod", "+x", path], { stdout: "pipe", stderr: "pipe" })
  const [, stderr, exitCode] = await Promise.all([
    new Response(chmod.stdout).text(),
    new Response(chmod.stderr).text(),
    chmod.exited,
  ])
  expect(exitCode, stderr).toBe(0)
}

async function createTrunkShimProject(
  options: { enabled?: boolean; state?: string } = {}
): Promise<string> {
  const project = await tmp.create("swiz-shim-trunk-")
  const swizDir = join(project, ".swiz")
  await mkdir(swizDir, { recursive: true })
  await Bun.write(
    join(swizDir, "config.json"),
    JSON.stringify({ defaultBranch: "main", trunkMode: options.enabled ?? true })
  )
  if (options.state) {
    await Bun.write(join(swizDir, "state.json"), JSON.stringify({ state: options.state }))
  }
  return project
}

async function createShimCommandStub(
  project: string,
  name: string,
  contents: string
): Promise<string> {
  const binDir = join(project, "bin")
  await mkdir(binDir, { recursive: true })
  await writeExecutable(join(binDir, name), contents)
  return binDir
}

async function runSourcedShim(
  cwd: string,
  command: string,
  env: Record<string, string> = {},
  shell = ZSH_PATH ?? "zsh"
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runShell(shell, ["-f", "-c", 'source "$1"; eval "$2"', "swiz", SHIM_PATH, command], {
    cwd,
    env: { SWIZ_SHIM: "strict", ...env },
  })
}

async function createMockGitProject(suffix: string) {
  const repo = await tmp.create(`swiz-shim-${suffix}-`)
  const binDir = await createShimCommandStub(repo, "git", "#!/bin/sh\nexit 0\n")
  await Bun.write(join(repo, "Library/LaunchAgents/com.swiz.daemon.plist"), "fixture")
  return { repo, env: { HOME: repo, PATH: `${binDir}:${process.env.PATH}`, SWIZ_SHIM: "strict" } }
}

describe("shell shim runtime", () => {
  for (const pm of ["npm", "pnpm"] as const) {
    for (const shellPath of ["/bin/bash", ...(ZSH_PATH ? [ZSH_PATH] : [])]) {
      test(`${pm}/${shellPath} ownership permits Bun runtime commands in both guard layers`, async () => {
        const project = await tmp.create(`swiz-bun-runtime-${pm}-`)
        const bunProject = await tmp.create("swiz-bun-owner-")
        await Bun.write(
          join(bunProject, "package.json"),
          JSON.stringify({ packageManager: "bun@1.3.14" })
        )
        await Bun.write(
          join(project, "package.json"),
          JSON.stringify({
            packageManager: `${pm}@11.0.0`,
            scripts: { build: "echo build", lint: "echo lint", "helper.ts": "echo package-script" },
          })
        )
        await Bun.write(join(project, pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml"), "")
        await Bun.write(join(project, "helper.ts"), "console.log('runtime')\n")
        await Bun.write(join(project, "helper with spaces.ts"), "console.log('runtime')\n")
        await Bun.write(join(project, "Library/LaunchAgents/com.swiz.daemon.plist"), "fixture")
        const binDir = await createShimCommandStub(
          project,
          "bun",
          [
            "#!/bin/sh",
            'case "$1" in',
            '  */bun-command-policy.ts) exec "$SWIZ_TEST_BUN" "$@" ;;',
            '  -e) case "$2" in *"const supported = new Set"*) exec "$SWIZ_TEST_BUN" "$@" ;; esac ;;',
            "esac",
            'printf "%s\\n" "$@"',
            "",
          ].join("\n")
        )
        const env = {
          HOME: project,
          ZDOTDIR: project,
          BASH_ENV: "",
          SWIZ_BYPASS: "",
          SWIZ_TEST_BUN: process.execPath,
          PATH: `${binDir}:${process.env.PATH}`,
        }
        const runtimeCases = [
          ["helper.ts"],
          ["./helper with spaces.ts", "install", "--cwd", "not a directory"],
          [join(project, "helper with spaces.ts"), "two words"],
          ["run", "./helper with spaces.ts"],
          ["--hot", "./helper.ts"],
          ["--cwd", project, "./helper.ts"],
          ["run", "--cwd", project, "./helper with spaces.ts"],
          ["-e", "console.log('install --global')"],
          ["--eval=console.log('ok')"],
          ["--print", "1 + 1"],
          ["--version"],
          ["--revision"],
          ["test", "--reporter=dots"],
        ]
        for (const args of runtimeCases) {
          const command = ["bun", ...args].map(quotePosixShellArg).join(" ")
          const shell = await runSourcedShim(project, command, env, shellPath)
          expect(shell.exitCode, `${pm}: ${command}: ${shell.stderr}`).toBe(0)
          expect(shell.stdout).toBe(`${args.join("\n")}\n`)
          const payload = { cwd: project, tool_name: "Bash", tool_input: { command } }
          const packageResult = await noNpmHook.run(payload)
          const packageJson = JSON.stringify(packageResult)
          expect(packageResult).toMatchObject({
            hookSpecificOutput: {
              permissionDecision: "allow",
              permissionDecisionReason: expect.stringContaining("Bun runtime"),
            },
          })
          expect(packageJson).toContain(`Target cwd: ${project}`)
          expect(packageJson).toContain(`${pm} from packageManager`)
          expect(await evaluatePretooluseBannedCommands(payload)).toEqual({})
        }
        for (const args of [
          ["install"],
          ["add", "lodash"],
          ["remove", "lodash"],
          ["run", "build"],
          ["run", "helper.ts"],
          ["run", "build", "--cwd", bunProject],
          ["run", "add", "--global"],
          ["lint", "--cwd", bunProject],
          ["install", "--", "--global"],
          ["--cwd", project, "install"],
          ["install", "--cwd", project],
          ["build"],
        ]) {
          const command = ["bun", ...args].map(quotePosixShellArg).join(" ")
          const shell = await runSourcedShim(project, command, env, shellPath)
          expect(shell.exitCode, command).toBe(1)
          expect(shell.stdout).toBe("")
          expect(shell.stderr).toContain("packageManager")
          expect(shell.stderr).toContain(project)
          const result = await noNpmHook.run({
            cwd: project,
            tool_name: "Bash",
            tool_input: { command },
          })
          expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
        }
        // A daemon handling multiple projects must not inherit this test process's Bun policy.
        expect(
          await evaluatePretooluseBannedCommands({
            cwd: project,
            tool_name: "Bash",
            tool_input: { command: "node helper.js" },
          })
        ).toEqual({})
        const nodeInBun = await evaluatePretooluseBannedCommands({
          cwd: bunProject,
          tool_name: "Bash",
          tool_input: { command: "node helper.js" },
        })
        expect(nodeInBun).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: expect.stringContaining(bunProject),
          },
        })
        expect(
          await evaluatePretooluseBannedCommands({
            cwd: project,
            tool_name: "Bash",
            tool_input: { command: "node helper.js" },
          })
        ).toEqual({})
        const targetCommand = ["bun", "--cwd", project, "install"].map(quotePosixShellArg).join(" ")
        const targeted = await runSourcedShim(bunProject, targetCommand, env, shellPath)
        expect(targeted.exitCode).toBe(1)
        expect(targeted.stderr).toContain(`Target cwd: ${project}`)
        expect(
          await noNpmHook.run({
            cwd: bunProject,
            tool_name: "Bash",
            tool_input: { command: targetCommand },
          })
        ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
        for (const cwdField of ["cwd", "workdir"]) {
          const toolInput = { [cwdField]: project, command: "bun install" }
          const packageResult = await noNpmHook.run({
            cwd: bunProject,
            tool_name: "Bash",
            tool_input: toolInput,
          })
          expect(JSON.stringify(packageResult)).toContain(`Target cwd: ${project}`)
          expect(packageResult).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          })
          expect(
            await evaluatePretooluseBannedCommands({
              cwd: bunProject,
              tool_name: "Bash",
              tool_input: { ...toolInput, command: "node helper.js" },
            })
          ).toEqual({})
        }
      })
    }
  }

  testWithZsh(
    "keeps walk-up detector output clean across multiple parent directories",
    async () => {
      const project = await tmp.create("swiz-shim-pm-walkup-")
      const child = join(project, "nested", "child")
      await mkdir(child, { recursive: true })
      await Bun.write(join(project, "bun.lock"), "")
      const binDir = await createShimCommandStub(
        project,
        "bun",
        '#!/bin/sh\nprintf "mock-bun:%s\\n" "$*"\n'
      )
      const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: project }
      await Bun.write(join(project, "Library/LaunchAgents/com.swiz.daemon.plist"), "fixture")

      const detected = await runSourcedShim(child, '_swiz_detect_pm "$PWD"', env)
      expect(detected.exitCode).toBe(0)
      expect(detected.stdout).toBe("bun\n")
      const version = await runSourcedShim(child, "bun --version", env)
      expect(version.exitCode).toBe(0)
      expect(version.stdout).toBe("mock-bun:--version\n")
      expect(version.stderr).toBe("")
    }
  )

  testWithZsh(
    "keeps project lookup and repeated Git options free of local declarations",
    async () => {
      const project = await createTrunkShimProject({ enabled: false })
      const child = join(project, "nested", "child")
      await mkdir(child, { recursive: true })
      const binDir = await createShimCommandStub(
        project,
        "git",
        '#!/bin/sh\nprintf "git:%s\\n" "$*"\n'
      )
      await Bun.write(join(project, "Library/LaunchAgents/com.swiz.daemon.plist"), "fixture")
      const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: project }
      const detected = await runSourcedShim(child, `_swiz_project_dir '${child}'`, env)
      expect(detected.stdout).toBe(`${project}\n`)
      const git = await runSourcedShim(project, "git -C. -C. status", env)
      expect(git.exitCode).toBe(0)
      expect(git.stdout).toBe("git:-C. -C. status\n")

      await createShimCommandStub(project, "find", "#!/bin/sh\nexit 0\n")
      await Bun.write(join(project, "first.txt"), "first")
      await Bun.write(join(project, "second.txt"), "second")
      const added = await runSourcedShim(
        project,
        '_swiz_get_setting() { [[ "$1" == "largeFileSizeBlockKb" ]] && printf "1024\\n"; }; git add first.txt second.txt',
        env
      )
      expect(added.exitCode).toBe(0)
      expect(added.stdout).toBe("git:add first.txt second.txt\n")
    }
  )

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

  testWithZsh("blocks branch and worktree creation in trunk mode", async () => {
    const project = await createTrunkShimProject()
    const commands = [
      "git checkout -b feat/new",
      "git checkout --orphan feat/orphan",
      "git switch --create=feat/new",
      "git switch -C feat/reset",
      "git branch feat/direct",
      "git -C . branch --track feat/tracked origin/main",
      "git branch --copy main feat/copied",
      "git worktree add ../feature",
    ]

    for (const command of commands) {
      const result = await runSourcedShim(project, command)
      expect(result.exitCode, command).toBe(1)
      expect(result.stderr, command).toContain("Trunk mode")
    }
  })

  testWithZsh("resolves trunk mode from child cwd and git -C targets", async () => {
    const project = await createTrunkShimProject()
    const child = join(project, "src")
    const outside = await tmp.create("swiz-shim-trunk-outside-")
    await mkdir(child, { recursive: true })
    const binDir = await createShimCommandStub(
      project,
      "git",
      "#!/usr/bin/env sh\nprintf 'git:%s\\n' \"$*\"\n"
    )
    const env = { PATH: [binDir, process.env.PATH ?? ""].join(":") }

    const fromChild = await runSourcedShim(child, "git checkout -b feat/child")
    expect(fromChild.exitCode).toBe(1)
    expect(fromChild.stderr).toContain("Trunk mode")

    const fromTarget = await runSourcedShim(
      outside,
      ["git -C", project, "worktree add ../feature"].join(" ")
    )
    expect(fromTarget.exitCode).toBe(1)
    expect(fromTarget.stderr).toContain("Trunk mode")

    const unrelatedTarget = await runSourcedShim(
      project,
      ["git -C", outside, "checkout -b feat/outside"].join(" "),
      env
    )
    expect(unrelatedTarget.exitCode).toBe(0)
    expect(unrelatedTarget.stdout).toContain("git:-C")
    expect(unrelatedTarget.stderr).not.toContain("Trunk mode")
  })

  testWithZsh("keeps trunk recovery and cleanup commands available", async () => {
    const project = await createTrunkShimProject()
    const binDir = await createShimCommandStub(
      project,
      "git",
      "#!/usr/bin/env sh\nprintf 'git:%s\\n' \"$*\"\n"
    )
    const env = { PATH: [binDir, process.env.PATH ?? ""].join(":") }
    const cases = [
      ["git switch main", "switch main"],
      ["git checkout feat/existing", "checkout feat/existing"],
      ["git branch --list", "branch --list"],
      ["git branch -d feat/merged", "branch -d feat/merged"],
      ["git worktree list", "worktree list"],
    ] as const

    for (const [command, delegated] of cases) {
      const result = await runSourcedShim(project, command, env)
      expect(result.exitCode, command).toBe(0)
      expect(result.stdout, command).toContain(["git:", delegated, "\n"].join(""))
      expect(result.stderr, command).not.toContain("Trunk mode")
    }
  })

  testWithZsh("blocks new pull-request workflow in trunk mode", async () => {
    const project = await createTrunkShimProject()
    const binDir = await createShimCommandStub(
      project,
      "gh",
      "#!/usr/bin/env sh\nprintf 'gh:%s\\n' \"$*\"\n"
    )
    const env = { PATH: [binDir, process.env.PATH ?? ""].join(":") }

    for (const command of ["gh pr create --fill", "gh pr checkout 42"]) {
      const result = await runSourcedShim(project, command, env)
      expect(result.exitCode, command).toBe(1)
      expect(result.stderr, command).toContain("Trunk mode")
      expect(result.stdout, command).toBe("")
    }
  })

  testWithZsh("blocks pull-request creation behind repository selectors", async () => {
    // #816: the wrapper read $1/$2 as command/subcommand, so any inherited global option
    // shifted the real command out of view and `gh --repo x pr create --fill` ran for real.
    const project = await createTrunkShimProject()
    const binDir = await createShimCommandStub(
      project,
      "gh",
      "#!/usr/bin/env sh\nprintf 'gh:%s\\n' \"$*\"\n"
    )
    const env = { PATH: [binDir, process.env.PATH ?? ""].join(":") }

    for (const command of [
      "gh --repo mherod/swiz pr create --fill",
      "gh --repo=mherod/swiz pr create --fill",
      "gh -R mherod/swiz pr create --fill",
      "gh -R=mherod/swiz pr create --fill",
      "gh -Rmherod/swiz pr create --fill",
      // An option value that looks like a command must not be mistaken for one.
      "gh --repo pr pr create --fill",
    ]) {
      const result = await runSourcedShim(project, command, env)
      expect(result.exitCode, command).toBe(1)
      expect(result.stderr, command).toContain("Trunk mode")
      expect(result.stdout, command).toBe("")
    }
  })

  testWithZsh("leaves unrelated gh commands alone behind repository selectors", async () => {
    // Control for the block above: the parser must not turn into a blanket `pr` matcher.
    const project = await createTrunkShimProject()
    const binDir = await createShimCommandStub(
      project,
      "gh",
      "#!/usr/bin/env sh\nprintf 'gh:%s\\n' \"$*\"\n"
    )
    const env = { PATH: [binDir, process.env.PATH ?? ""].join(":") }

    for (const command of [
      "gh --repo mherod/swiz issue list",
      "gh -R mherod/swiz pr view 42",
      "gh pr merge 42",
    ]) {
      const result = await runSourcedShim(project, command, env)
      expect(result.exitCode, command).toBe(0)
      expect(result.stderr, command).not.toContain("Trunk mode")
    }
  })

  testWithZsh("allows PR checkout only for an active trunk review", async () => {
    const project = await createTrunkShimProject({ state: "reviewing" })
    const child = join(project, "src")
    await mkdir(child, { recursive: true })
    const binDir = await createShimCommandStub(
      project,
      "gh",
      [
        "#!/usr/bin/env sh",
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
        "  printf 'true\\n'",
        "  exit 0",
        "fi",
        "printf 'gh:%s\\n' \"$*\"",
        "",
      ].join("\n")
    )
    const result = await runSourcedShim(child, "gh pr checkout 42", {
      PATH: [binDir, process.env.PATH ?? ""].join(":"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("gh:pr checkout 42\n")
    expect(result.stderr).not.toContain("Trunk mode")
  })

  testWithZsh("blocks PR checkout when a trunk review has no open PR", async () => {
    const project = await createTrunkShimProject({ state: "reviewing" })
    const binDir = await createShimCommandStub(
      project,
      "gh",
      [
        "#!/usr/bin/env sh",
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
        "  printf 'false\\n'",
        "  exit 0",
        "fi",
        "printf 'gh:%s\\n' \"$*\"",
        "",
      ].join("\n")
    )
    const result = await runSourcedShim(project, "gh pr checkout 42", {
      PATH: [binDir, process.env.PATH ?? ""].join(":"),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Trunk mode")
    expect(result.stdout).toBe("")
  })

  testWithZsh("leaves branch creation available when trunk mode is disabled", async () => {
    const project = await createTrunkShimProject({ enabled: false })
    const binDir = await createShimCommandStub(
      project,
      "git",
      "#!/usr/bin/env sh\nprintf 'git:%s\\n' \"$*\"\n"
    )
    const result = await runSourcedShim(project, "git checkout -b feat/allowed", {
      PATH: [binDir, process.env.PATH ?? ""].join(":"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("git:checkout -b feat/allowed\n")
    expect(result.stderr).not.toContain("Trunk mode")
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
    const { repo, env } = await createMockGitProject("zsh")
    const status = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; git -C "$2" status --short', "swiz", SHIM_PATH, repo],
      { cwd: repo, env }
    )
    expect(status.exitCode).toBe(0)
    expect(status.stderr).not.toContain("bad substitution")

    const forcePush = await runShell(
      ZSH_PATH ?? "zsh",
      ["-f", "-c", 'source "$1"; git push --force origin main', "swiz", SHIM_PATH],
      { cwd: repo, env }
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
      const { repo, env } = await createMockGitProject("restore")
      const emptyFile = join(repo, "empty.txt")
      const populatedFile = join(repo, "populated.txt")
      await Bun.write(emptyFile, "")
      await Bun.write(populatedFile, "cannot delete\n")

      const emptyResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore empty.txt', "swiz", SHIM_PATH],
        { cwd: repo, env }
      )
      expect(emptyResult.stderr).not.toContain("Do not use `git restore`")

      const missingResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore non-existent.txt', "swiz", SHIM_PATH],
        { cwd: repo, env }
      )
      expect(missingResult.stderr).not.toContain("Do not use `git restore`")

      const populatedResult = await runShell(
        ZSH_PATH ?? "zsh",
        ["-f", "-c", 'source "$1"; git restore populated.txt', "swiz", SHIM_PATH],
        { cwd: repo, env }
      )
      expect(populatedResult.exitCode).toBe(1)
      expect(populatedResult.stderr).toContain("swiz: Do not use `git restore`")
    }
  )

  test("does not remove an existing Git index lock", async () => {
    const { repo, env } = await createMockGitProject("lock")
    const lockPath = join(repo, ".git", "index.lock")
    await Bun.write(lockPath, "owned elsewhere\n")

    const result = await runShell(
      "/bin/bash",
      ["-c", 'source "$1"; git status --short', "swiz", SHIM_PATH],
      { cwd: repo, env }
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
