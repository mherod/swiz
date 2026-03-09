import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProjectState, writeProjectState } from "../src/settings.ts"

async function runHook(
  cwd: string,
  command: string,
  envOverrides: Record<string, string | undefined> = {}
): Promise<number> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })

  const proc = Bun.spawn(["bun", "hooks/posttooluse-state-transition.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  await proc.exited
  return proc.exitCode ?? 1
}

function runGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr)
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  }
  return new TextDecoder().decode(proc.stdout).trim()
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-"))
  runGit(dir, ["init"])
  runGit(dir, ["config", "user.email", "test@example.com"])
  runGit(dir, ["config", "user.name", "Test User"])
  await writeFile(join(dir, "README.md"), "init\n")
  runGit(dir, ["add", "README.md"])
  runGit(dir, ["commit", "-m", "init"])
  runGit(dir, ["branch", "-M", "main"])
  return dir
}

const cleanupDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe("posttooluse-state-transition no-upstream commit behavior", () => {
  test("git commit on no-upstream branch transitions reviewing -> developing", async () => {
    const repo = await createRepo()
    cleanupDirs.push(repo)
    runGit(repo, ["checkout", "-b", "feature/no-upstream"])
    await writeProjectState(repo, "reviewing")

    const exitCode = await runHook(repo, 'git commit -m "test"')
    expect(exitCode).toBe(0)
    expect(await readProjectState(repo)).toBe("developing")
  })

  test("git commit on no-upstream branch keeps developing unchanged", async () => {
    const repo = await createRepo()
    cleanupDirs.push(repo)
    runGit(repo, ["checkout", "-b", "feature/no-upstream"])
    await writeProjectState(repo, "developing")

    const exitCode = await runHook(repo, 'git commit -m "test"')
    expect(exitCode).toBe(0)
    expect(await readProjectState(repo)).toBe("developing")
  })

  test("git commit on gone-upstream branch transitions addressing-feedback -> developing", async () => {
    const repo = await createRepo()
    const remote = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-remote-"))
    cleanupDirs.push(repo, remote)

    runGit(remote, ["init", "--bare"])
    runGit(repo, ["remote", "add", "origin", remote])
    runGit(repo, ["push", "-u", "origin", "main"])

    runGit(repo, ["checkout", "-b", "feature/gone-upstream"])
    await writeFile(join(repo, "README.md"), "changed\n")
    runGit(repo, ["add", "README.md"])
    runGit(repo, ["commit", "-m", "feature"])
    runGit(repo, ["push", "-u", "origin", "feature/gone-upstream"])
    runGit(repo, ["push", "origin", "--delete", "feature/gone-upstream"])

    await writeProjectState(repo, "addressing-feedback")
    const exitCode = await runHook(repo, 'git commit -m "test"')
    expect(exitCode).toBe(0)
    expect(await readProjectState(repo)).toBe("developing")
  })

  test("existing CHANGES_REQUESTED transition still moves reviewing -> addressing-feedback", async () => {
    const repo = await createRepo()
    cleanupDirs.push(repo)
    runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
    await writeProjectState(repo, "reviewing")

    const fakeBin = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-gh-"))
    cleanupDirs.push(fakeBin)
    const fakeGhPath = join(fakeBin, "gh")
    await writeFile(
      fakeGhPath,
      '#!/bin/sh\necho \'[{"reviews":[{"state":"CHANGES_REQUESTED"}]}]\'\n'
    )
    await chmod(fakeGhPath, 0o755)

    const exitCode = await runHook(repo, 'git commit -m "test"', {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    })
    expect(exitCode).toBe(0)
    expect(await readProjectState(repo)).toBe("addressing-feedback")
  })
})
