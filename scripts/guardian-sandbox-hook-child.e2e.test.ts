import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"

/**
 * Owning boundary: the Codex OS sandbox, not Swiz's transcript-level guardian hook.
 * Run with SWIZ_RUN_CODEX_SANDBOX_E2E=1 to exercise the installed Codex runtime.
 */
const RUN_SANDBOX_E2E = process.env.SWIZ_RUN_CODEX_SANDBOX_E2E === "1"
const PRE_PUSH_ENTERED = "SWIZ_GUARDIAN_PRE_PUSH_ENTERED"
const CHILD_LISTENING = "SWIZ_GUARDIAN_CHILD_LISTENING="
const PRE_PUSH_COMPLETED = "SWIZ_GUARDIAN_PRE_PUSH_COMPLETED"

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  output: string
}

const tmp = useTempDir("swiz-guardian-sandbox-")

async function run(command: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, output: `${stdout}${stderr}` }
}

async function runSuccessfully(command: string[], cwd: string): Promise<CommandResult> {
  const result = await run(command, cwd)
  expect(result.exitCode, result.output).toBe(0)
  return result
}

async function createGitHookFixture(): Promise<{
  fixtureRoot: string
  worktree: string
}> {
  const fixtureRoot = await tmp.create()
  const worktree = join(fixtureRoot, "work")
  const remote = join(fixtureRoot, "remote.git")

  await runSuccessfully(["git", "init", "--bare", remote], fixtureRoot)
  await runSuccessfully(["git", "init", "-b", "main", worktree], fixtureRoot)
  await runSuccessfully(["git", "config", "user.name", "swiz-fixture"], worktree)
  await runSuccessfully(["git", "config", "user.email", "swiz-fixture@example.invalid"], worktree)
  await runSuccessfully(["git", "remote", "add", "origin", remote], worktree)

  await Bun.write(
    join(worktree, "hook-child.ts"),
    [
      'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })',
      `console.error(\`${CHILD_LISTENING}\${server.hostname}:\${server.port}\`)`,
      "server.stop(true)",
      "",
    ].join("\n")
  )
  const hookPath = join(worktree, ".git", "hooks", "pre-push")
  await Bun.write(
    hookPath,
    [
      "#!/bin/sh",
      "set -eu",
      `echo "${PRE_PUSH_ENTERED}" >&2`,
      "bun hook-child.ts",
      `echo "${PRE_PUSH_COMPLETED}" >&2`,
      "",
    ].join("\n")
  )
  await runSuccessfully(["chmod", "+x", hookPath], fixtureRoot)
  await Bun.write(join(worktree, "README.md"), "# Guardian sandbox fixture\n")
  await runSuccessfully(["git", "add", "README.md", "hook-child.ts"], worktree)
  await runSuccessfully(["git", "commit", "-m", "test: initialise fixture"], worktree)

  return { fixtureRoot, worktree }
}

function sandboxCommand(
  profile: ":workspace" | ":danger-full-access",
  cwd: string,
  command: string[]
): string[] {
  return [
    "codex",
    "sandbox",
    "--permission-profile",
    profile,
    "--cd",
    cwd,
    ...(profile === ":workspace" ? ["--log-denials"] : []),
    "--",
    ...command,
  ]
}

describe.skipIf(!RUN_SANDBOX_E2E)("Codex guardian sandbox propagation", () => {
  test("limits an approved Git push profile to its hook descendants", async () => {
    expect(Bun.which("codex"), "Codex CLI is required for this opt-in fixture").not.toBeNull()
    const { worktree } = await createGitHookFixture()

    const ordinaryPush = await run(
      sandboxCommand(":workspace", worktree, ["git", "push", "--set-upstream", "origin", "main"]),
      worktree
    )
    expect(ordinaryPush.exitCode).not.toBe(0)
    expect(ordinaryPush.output).toContain(PRE_PUSH_ENTERED)
    expect(ordinaryPush.output).not.toContain(PRE_PUSH_COMPLETED)
    expect(ordinaryPush.output).toContain("network-bind")

    const approvedPush = await run(
      sandboxCommand(":danger-full-access", worktree, [
        "git",
        "push",
        "--set-upstream",
        "origin",
        "main",
      ]),
      worktree
    )
    expect(approvedPush.exitCode, approvedPush.output).toBe(0)
    expect(approvedPush.output).toContain(PRE_PUSH_ENTERED)
    expect(approvedPush.output).toContain(CHILD_LISTENING)
    expect(approvedPush.output).toContain(PRE_PUSH_COMPLETED)

    const unrelatedCommand = await run(
      sandboxCommand(":workspace", worktree, ["bun", "hook-child.ts"]),
      worktree
    )
    expect(unrelatedCommand.exitCode).not.toBe(0)
    expect(unrelatedCommand.output).not.toContain(CHILD_LISTENING)
    expect(unrelatedCommand.output).toContain("network-bind")
  }, 30_000)
})
