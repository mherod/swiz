import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateNoHomePaths } from "./pretooluse-no-home-paths.ts"

const TEST_HOME = "/Users/example-person"

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
}

function input(cwd: string, command = 'git commit -m "test: portable paths"') {
  return {
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  }
}

describe("pretooluse-no-home-paths", () => {
  let cwd = ""

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "swiz-no-home-paths-"))
    runGit(cwd, ["init", "-q"])
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function stage(path: string, content: string): Promise<void> {
    await Bun.write(join(cwd, path), content)
    runGit(cwd, ["add", "--", path])
  }

  it("blocks a commit when a staged snapshot contains the absolute home path", async () => {
    await stage(
      "requirements-status.json",
      JSON.stringify({ command: `bun ${TEST_HOME}/.agents/skills/validate.js` })
    )

    const result = await evaluateNoHomePaths(input(cwd), { homeDir: TEST_HOME })

    expect(JSON.stringify(result)).toContain('"permissionDecision":"deny"')
    expect(JSON.stringify(result)).toContain("requirements-status.json")
    expect(JSON.stringify(result)).toContain("repository-relative path")
    expect(JSON.stringify(result)).toContain("re-stage")
  })

  it("blocks through the standalone hook stdin and stdout contract", async () => {
    await stage("receipt.json", `{"command":"${TEST_HOME}/bin/tool"}`)
    const hookPath = join(import.meta.dir, "pretooluse-no-home-paths.ts")
    const proc = Bun.spawn(["bun", hookPath], {
      cwd,
      env: { ...process.env, HOME: TEST_HOME },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(JSON.stringify(input(cwd)))
    await proc.stdin.end()

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny")
  })

  it("reads the index when a bad staged snapshot was scrubbed only in the worktree", async () => {
    await stage("receipt.json", `{"command":"${TEST_HOME}/bin/tool"}`)
    await Bun.write(join(cwd, "receipt.json"), '{"command":"~/bin/tool"}')

    const result = await evaluateNoHomePaths(input(cwd), { homeDir: TEST_HOME })

    expect(JSON.stringify(result)).toContain('"permissionDecision":"deny"')
  })

  it("allows a clean staged snapshot when only the unstaged worktree contains the path", async () => {
    await stage("receipt.json", '{"command":"~/bin/tool"}')
    await Bun.write(join(cwd, "receipt.json"), `{"command":"${TEST_HOME}/bin/tool"}`)

    const result = await evaluateNoHomePaths(input(cwd), { homeDir: TEST_HOME })

    expect(result).toEqual({})
  })

  it("allows portable home and repository-relative paths", async () => {
    await stage(
      "receipt.json",
      JSON.stringify({ commands: ["~/.agents/tool", "$HOME/.agents/tool", "./scripts/tool"] })
    )

    const result = await evaluateNoHomePaths(input(cwd), { homeDir: TEST_HOME })

    expect(result).toEqual({})
  })

  it("requires index mutations and commits to use separate tool calls", async () => {
    await Bun.write(join(cwd, "receipt.json"), '{"command":"~/bin/tool"}')

    const result = await evaluateNoHomePaths(
      input(cwd, 'git add receipt.json && git commit -m "test: portable paths"'),
      { homeDir: TEST_HOME }
    )

    expect(JSON.stringify(result)).toContain('"permissionDecision":"deny"')
    expect(JSON.stringify(result)).toContain("separate shell tool calls")
    expect(JSON.stringify(result)).toContain("final Git index")
  })

  it("ignores non-commit commands and quoted mentions of git commit", async () => {
    await stage("receipt.json", `{"command":"${TEST_HOME}/bin/tool"}`)

    const statusResult = await evaluateNoHomePaths(input(cwd, "git status"), {
      homeDir: TEST_HOME,
    })
    const quotedResult = await evaluateNoHomePaths(
      input(cwd, 'gh issue create --body "please run git commit after fixing this"'),
      { homeDir: TEST_HOME }
    )

    expect(statusResult).toEqual({})
    expect(quotedResult).toEqual({})
  })
})
