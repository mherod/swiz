import { describe, expect, test } from "bun:test"
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

async function createFakeGhBin(
  currentUser: string,
  recentContributorLogins: string[] = []
): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-gh-"))
  const fakeGhPath = join(fakeBin, "gh")
  const commitsPayload = JSON.stringify(
    recentContributorLogins.map((login) => ({
      author: { login },
      commit: { author: { date: new Date().toISOString() } },
    }))
  )
  await writeFile(
    fakeGhPath,
    `#!/bin/sh
if [ "$1" = "api" ] && echo " $* " | grep -q " user "; then
  echo "${currentUser}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo "[]"
  exit 0
fi
if [ "$1" = "api" ]; then
  echo '${commitsPayload}'
  exit 0
fi
echo ""
exit 0
`
  )
  await chmod(fakeGhPath, 0o755)
  return fakeBin
}

function setMainUpstreamTracking(repo: string): void {
  runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  runGit(repo, ["branch", "--set-upstream-to=origin/main", "main"])
}

describe("posttooluse-state-transition no-upstream commit behavior", () => {
  test("git commit on no-upstream branch transitions reviewing -> developing", async () => {
    const repo = await createRepo()
    try {
      runGit(repo, ["checkout", "-b", "feature/no-upstream"])
      await writeProjectState(repo, "reviewing")

      const exitCode = await runHook(repo, 'git commit -m "test"')
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("developing")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("git commit on no-upstream branch keeps developing unchanged", async () => {
    const repo = await createRepo()
    try {
      runGit(repo, ["checkout", "-b", "feature/no-upstream"])
      await writeProjectState(repo, "developing")

      const exitCode = await runHook(repo, 'git commit -m "test"')
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("developing")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("git commit on gone-upstream branch transitions addressing-feedback -> developing", async () => {
    const repo = await createRepo()
    const remote = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-remote-"))
    try {
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
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(remote, { recursive: true, force: true }),
      ])
    }
  })

  test("existing CHANGES_REQUESTED transition still moves reviewing -> addressing-feedback", async () => {
    const repo = await createRepo()
    const fakeBin = await mkdtemp(join(tmpdir(), "posttooluse-state-transition-gh-"))
    try {
      runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
      await writeProjectState(repo, "reviewing")

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
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("solo mode: git commit on default branch transitions reviewing -> developing", async () => {
    const repo = await createRepo()
    const fakeBin = await createFakeGhBin("mherod")
    try {
      runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
      setMainUpstreamTracking(repo)
      await writeProjectState(repo, "reviewing")

      const exitCode = await runHook(repo, 'git commit -m "test"', {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("developing")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("solo mode: git commit on default branch transitions addressing-feedback -> developing", async () => {
    const repo = await createRepo()
    const fakeBin = await createFakeGhBin("mherod")
    try {
      runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
      setMainUpstreamTracking(repo)
      await writeProjectState(repo, "addressing-feedback")

      const exitCode = await runHook(repo, 'git commit -m "test"', {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("developing")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("team mode: git commit on default branch does not auto-transition reviewing", async () => {
    const repo = await createRepo()
    const fakeBin = await createFakeGhBin("mherod", ["teammate"])
    try {
      runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
      setMainUpstreamTracking(repo)
      await writeProjectState(repo, "reviewing")

      const exitCode = await runHook(repo, 'git commit -m "test"', {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("reviewing")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("solo mode: git commit on feature branch keeps reviewing unchanged", async () => {
    const repo = await createRepo()
    const fakeBin = await createFakeGhBin("mherod")
    try {
      runGit(repo, ["remote", "add", "origin", "https://github.com/mherod/swiz.git"])
      setMainUpstreamTracking(repo)
      runGit(repo, ["checkout", "-b", "feature/solo"])
      runGit(repo, ["update-ref", "refs/remotes/origin/feature/solo", "HEAD"])
      runGit(repo, ["branch", "--set-upstream-to=origin/feature/solo", "feature/solo"])
      await writeProjectState(repo, "reviewing")

      const exitCode = await runHook(repo, 'git commit -m "test"', {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      expect(exitCode).toBe(0)
      expect(await readProjectState(repo)).toBe("reviewing")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })
})
