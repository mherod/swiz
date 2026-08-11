import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGitStatusV2, getUnpushedCommitCount } from "./git-utils.ts"

const tempDirs: string[] = []

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`)
  return stdout.trim()
}

async function makeRepoWithStaleTrackingRef(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swiz-verified-parity-"))
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  tempDirs.push(root)

  await runGit(root, ["init", "--bare", remote])
  await runGit(root, ["init", "-b", "main", repo])
  await runGit(repo, ["config", "user.email", "test@example.com"])
  await runGit(repo, ["config", "user.name", "Test User"])
  await runGit(repo, ["remote", "add", "origin", remote])

  await Bun.write(join(repo, "README.md"), "first\n")
  await runGit(repo, ["add", "README.md"])
  await runGit(repo, ["commit", "-m", "first"])
  await runGit(repo, ["push", "-u", "origin", "main"])
  const firstCommit = await runGit(repo, ["rev-parse", "HEAD"])

  await Bun.write(join(repo, "README.md"), "second\n")
  await runGit(repo, ["add", "README.md"])
  await runGit(repo, ["commit", "-m", "second"])
  await runGit(repo, ["push", "origin", "main"])
  await runGit(repo, ["update-ref", "refs/remotes/origin/main", firstCommit])

  return repo
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("verified remote parity", () => {
  test("treats a remotely verified HEAD as pushed when the tracking ref is stale", async () => {
    const repo = await makeRepoWithStaleTrackingRef()

    expect(await runGit(repo, ["rev-list", "--count", "@{upstream}..HEAD"])).toBe("1")
    expect(await getUnpushedCommitCount(repo)).toBe(0)
    expect((await getGitStatusV2(repo))?.ahead).toBe(0)
  })
})
