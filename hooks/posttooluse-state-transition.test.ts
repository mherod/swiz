import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { readProjectState, writeProjectState } from "../src/settings.ts"
import { evaluatePosttooluseStateTransition } from "./posttooluse-state-transition.ts"

interface GitState {
  branch?: string
  defaultBranch?: string
  upstream?: string | null
  upstreamGone?: boolean
  previousBranch?: string | null
  originUrl?: string | null
  upstreamUrl?: string | null
  headEmail?: string
  userEmail?: string
}

function statusV2(state: GitState): string {
  const branch = state.branch ?? "main"
  const lines = ["# branch.oid abc123", `# branch.head ${branch}`]
  if (state.upstream !== undefined && state.upstream !== null) {
    lines.push(`# branch.upstream ${state.upstream}`)
    if (!state.upstreamGone) lines.push("# branch.ab +0 -0")
  }
  return `${lines.join("\n")}\n`
}

function createGitMock(state: GitState = {}): MockGitClient {
  return new MockGitClient((args) => {
    const command = args.join("\0")
    if (command === "rev-parse\0--git-dir") return ".git"
    if (command === "status\0--porcelain=v2\0--branch") return statusV2(state)
    if (command === "branch\0--show-current") return state.branch ?? "main"
    if (command === "remote\0get-url\0origin") {
      return state.originUrl ? state.originUrl : { exitCode: 1 }
    }
    if (command === "remote\0get-url\0upstream") {
      return state.upstreamUrl ? state.upstreamUrl : { exitCode: 1 }
    }
    if (command === "symbolic-ref\0refs/remotes/origin/HEAD") {
      return `refs/remotes/origin/${state.defaultBranch ?? "main"}`
    }
    if (command === "symbolic-ref\0refs/remotes/upstream/HEAD") {
      return state.upstreamUrl
        ? `refs/remotes/upstream/${state.defaultBranch ?? "main"}`
        : { exitCode: 1 }
    }
    if (command === "rev-parse\0--verify\0refs/heads/main") return "abc123"
    if (command === "rev-parse\0--abbrev-ref\0@{-1}") {
      return state.previousBranch ? state.previousBranch : { exitCode: 1 }
    }
    if (command === "log\0-1\0--format=%ae\0HEAD") {
      return state.headEmail ?? "test@example.com"
    }
    if (command === "config\0user.email") return state.userEmail ?? "test@example.com"
    return { exitCode: 1 }
  })
}

async function createRepoDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "posttooluse-state-transition-"))
}

async function runHook(
  cwd: string,
  command: string,
  git: MockGitClient,
  envOverrides: Record<string, string | undefined> = {}
): Promise<void> {
  const previousEnv = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    await withGitClient(git, async () => {
      await evaluatePosttooluseStateTransition({
        tool_name: "Bash",
        tool_input: { command },
        cwd,
      })
    })
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = await createRepoDir()
  try {
    return await fn(repo)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

describe("posttooluse-state-transition commit behavior", () => {
  for (const state of ["planning", "reviewing", "addressing-feedback"] as const) {
    test(`git commit on no-upstream branch transitions ${state} -> developing`, async () => {
      await withRepo(async (repo) => {
        const git = createGitMock({ branch: "feature/no-upstream", upstream: null })
        await writeProjectState(repo, state)

        await runHook(repo, 'git commit -m "test"', git)

        expect(await readProjectState(repo)).toBe("developing")
      })
    })
  }

  test("git commit on no-upstream branch keeps developing unchanged", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "feature/no-upstream", upstream: null })
      await writeProjectState(repo, "developing")

      await runHook(repo, 'git commit -m "test"', git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git commit on upstream-tracked branch keeps planning unchanged", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "feature/with-upstream",
        upstream: "origin/feature/with-upstream",
      })
      await writeProjectState(repo, "planning")

      await runHook(repo, 'git commit -m "test"', git)

      expect(await readProjectState(repo)).toBe("planning")
    })
  })

  test("git commit on gone-upstream branch transitions addressing-feedback -> developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "feature/gone-upstream",
        upstream: "origin/feature/gone-upstream",
        upstreamGone: true,
      })
      await writeProjectState(repo, "addressing-feedback")

      await runHook(repo, 'git commit -m "test"', git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git commit on default branch transitions reviewing -> developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "main",
        upstream: "origin/main",
      })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, 'git commit -m "test"', git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git commit on feature branch with upstream keeps reviewing unchanged", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "feature/solo",
        upstream: "origin/feature/solo",
      })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, 'git commit -m "test"', git)

      expect(await readProjectState(repo)).toBe("reviewing")
    })
  })
})

describe("posttooluse-state-transition checkout behavior", () => {
  test("git checkout -b from default branch transitions to developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "feature/from-main", previousBranch: "main" })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, "git checkout -b feature/from-main", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git checkout -b from non-default branch does not transition", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "feature/child", previousBranch: "feature/base" })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, "git checkout -b feature/child", git)

      expect(await readProjectState(repo)).toBe("reviewing")
    })
  })

  test("git checkout -b with explicit default start-point transitions to developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "feature/from-main" })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, "git checkout -b feature/from-main main", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git checkout branch with foreign-author HEAD transitions developing -> reviewing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "feature/other",
        headEmail: "other@example.com",
        userEmail: "test@example.com",
      })
      await writeProjectState(repo, "developing")

      await runHook(repo, "git checkout feature/other", git)

      expect(await readProjectState(repo)).toBe("reviewing")
    })
  })

  test("git checkout branch with self-authored HEAD does not transition to reviewing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "feature/mine",
        headEmail: "test@example.com",
        userEmail: "test@example.com",
      })
      await writeProjectState(repo, "developing")

      await runHook(repo, "git checkout feature/mine", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("checkout default branch takes priority over foreign-author rule", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({
        branch: "main",
        headEmail: "other@example.com",
        userEmail: "test@example.com",
      })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, "git checkout main", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git checkout default branch transitions planning -> developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "main" })
      await writeProjectState(repo, "planning")

      await runHook(repo, "git checkout main", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })

  test("git switch default branch transitions reviewing -> developing", async () => {
    await withRepo(async (repo) => {
      const git = createGitMock({ branch: "main" })
      await writeProjectState(repo, "reviewing")

      await runHook(repo, "git switch main", git)

      expect(await readProjectState(repo)).toBe("developing")
    })
  })
})
