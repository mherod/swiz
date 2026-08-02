import { describe, expect, test } from "bun:test"
import { evaluatePretooluseTrunkModeBranchGate } from "./pretooluse-trunk-mode-branch-gate.ts"

const trunkModeRepos = new Set<string>()
const projectStates = new Map<string, string>()
const openPrCounts = new Map<string, number>()
let nextRepoId = 0

function createTestRepo(
  _remote: string,
  _options: { featureBranch?: string } = {}
): Promise<string> {
  nextRepoId += 1
  return Promise.resolve(`/test/trunk-mode-repo-${nextRepoId}`)
}

function enableTrunkMode(repo: string): Promise<void> {
  trunkModeRepos.add(repo)
  return Promise.resolve()
}

function writeProjectState(repo: string, state: string): Promise<void> {
  projectStates.set(repo, state)
  return Promise.resolve()
}

function cleanupTestPath(path: string): Promise<void> {
  trunkModeRepos.delete(path)
  projectStates.delete(path)
  openPrCounts.delete(path)
  return Promise.resolve()
}

async function runHook(
  cwd: string,
  command: string,
  toolName = "Bash",
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ raw: string; parsed: Record<string, any> | null; decision?: string }> {
  const output = await evaluatePretooluseTrunkModeBranchGate(
    {
      tool_name: toolName,
      tool_input: { command, cwd },
      cwd,
    },
    {
      runtime: {
        isGitRepo: () => Promise.resolve(true),
        readProjectSettings: (repo) =>
          Promise.resolve(trunkModeRepos.has(repo) ? { trunkMode: true } : null),
        readProjectState: (repo) => Promise.resolve(projectStates.get(repo) ?? null),
        getDefaultBranch: () => Promise.resolve("main"),
        hasOpenPullRequests: () => {
          const mockBin = [...openPrCounts.keys()].find((path) =>
            envOverrides.PATH?.startsWith(`${path}:`)
          )
          return Promise.resolve(mockBin ? (openPrCounts.get(mockBin) ?? 0) > 0 : false)
        },
      },
    }
  )
  const parsed = Object.keys(output).length > 0 ? (output as Record<string, any>) : null
  const raw = parsed ? JSON.stringify(parsed) : ""
  const hso = parsed?.hookSpecificOutput as Record<string, any> | undefined
  const decision =
    (hso?.permissionDecision as string) ?? (parsed?.decision as string | undefined) ?? undefined
  return { raw, parsed, decision }
}

function createMockGhBin(openPrCount: number): Promise<string> {
  const binDir = `/test/mock-gh-${openPrCounts.size + 1}`
  openPrCounts.set(binDir, openPrCount)
  return Promise.resolve(binDir)
}

async function cleanupRepoAndMock(repo: string, mockGhBin?: string): Promise<void> {
  if (mockGhBin) await cleanupTestPath(mockGhBin)
  await cleanupTestPath(repo)
}

async function cleanupRepo(repo: string): Promise<void> {
  await cleanupTestPath(repo)
}

describe("pretooluse-trunk-mode-branch-gate", () => {
  test("allows branch creation when trunk mode is off", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    try {
      const result = await runHook(repo, "git checkout -b feat/off")
      expect(result.parsed).toBeNull()
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("blocks git checkout -b to a feature branch when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b feat/trunk-block")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, any>
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("Trunk mode")
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("feat/trunk-block")
    } finally {
      await cleanupRepo(repo)
    }
  })

  for (const command of ["git checkout main", "git switch main"]) {
    test(`allows returning to the default branch with ${command}`, async () => {
      const repo = await createTestRepo("https://github.com/mherod/repo.git", {
        featureBranch: "feat/side",
      })
      await enableTrunkMode(repo)
      try {
        const result = await runHook(repo, command)
        expect(result.parsed).toBeNull()
      } finally {
        await cleanupRepo(repo)
      }
    })
  }

  for (const command of [
    "git checkout feat/existing",
    "git switch feat/existing",
    "git checkout origin/feat/existing",
    "git switch --detach origin/feat/existing",
  ]) {
    test(`blocks switching away from trunk with ${command}`, async () => {
      const repo = await createTestRepo("https://github.com/mherod/repo.git", {
        featureBranch: "feat/existing",
      })
      await enableTrunkMode(repo)
      try {
        const result = await runHook(repo, command)
        expect(result.decision).toBe("deny")
        const hso = result.parsed?.hookSpecificOutput as Record<string, any>
        expect(String(hso?.permissionDecisionReason ?? "")).toContain("Trunk mode")
      } finally {
        await cleanupRepo(repo)
      }
    })
  }

  test("blocks git checkout -b main when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git", {
      featureBranch: "feat/side",
    })
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b main")
      expect(result.decision).toBe("deny")
    } finally {
      await cleanupRepo(repo)
    }
  })

  for (const command of [
    "git branch feat/direct",
    "git branch --track feat/tracked origin/main",
    "git -C . branch feat/global-option",
    "git checkout --orphan feat/orphan",
    "git switch --orphan feat/orphan",
    "git checkout -B feat/force-reset",
    "git switch -C feat/force-reset",
    "git switch --create=feat/long-form",
    "git branch -c main feat/copied",
    "git branch --copy main feat/copied-long",
    "git branch -m main feat/renamed",
    "git branch --move main feat/renamed-long",
    "git branch --force feat/force-updated main",
    "git worktree add /tmp/swiz-feature-worktree",
    "git worktree add -b feat/worktree /tmp/swiz-feature-worktree",
  ]) {
    test(`blocks branch or worktree creation with ${command}`, async () => {
      const repo = await createTestRepo("https://github.com/mherod/repo.git")
      await enableTrunkMode(repo)
      try {
        const result = await runHook(repo, command)
        expect(result.decision).toBe("deny")
        const hso = result.parsed?.hookSpecificOutput as Record<string, any>
        expect(String(hso?.permissionDecisionReason ?? "")).toContain("Trunk mode")
      } finally {
        await cleanupRepo(repo)
      }
    })
  }

  for (const command of [
    "git branch -d feat/merged",
    "git branch --delete feat/merged",
    "git worktree remove /tmp/swiz-old-worktree",
  ]) {
    test(`allows cleanup toward trunk compliance with ${command}`, async () => {
      const repo = await createTestRepo("https://github.com/mherod/repo.git")
      await enableTrunkMode(repo)
      try {
        const result = await runHook(repo, command)
        expect(result.parsed).toBeNull()
      } finally {
        await cleanupRepo(repo)
      }
    })
  }

  test("blocks compound command that creates a non-default branch", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout main && git checkout -b feat/second")
      expect(result.decision).toBe("deny")
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("blocks gh pr checkout when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "gh pr checkout 42")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, any>
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/pull request|PR/i)
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("allows gh pr checkout in reviewing state when open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "reviewing")
    const mockGhBin = await createMockGhBin(1)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.parsed).toBeNull()
    } finally {
      await cleanupRepoAndMock(repo, mockGhBin)
    }
  })

  test("blocks gh pr checkout in reviewing state when no open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "reviewing")
    const mockGhBin = await createMockGhBin(0)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.decision).toBe("deny")
    } finally {
      await cleanupRepoAndMock(repo, mockGhBin)
    }
  })

  test("blocks gh pr checkout in developing state even when open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "developing")
    const mockGhBin = await createMockGhBin(1)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, any>
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("developing")
    } finally {
      await cleanupRepoAndMock(repo, mockGhBin)
    }
  })

  test("blocks gh pr create when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "gh pr create --fill")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, any>
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/pull request|PR/i)
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/trunk mode/i)
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("allows gh pr create when trunk mode is off", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    try {
      const result = await runHook(repo, "gh pr create --fill")
      expect(result.parsed).toBeNull()
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("ignores non-shell tools", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b feat/x", "Read")
      expect(result.parsed).toBeNull()
    } finally {
      await cleanupRepo(repo)
    }
  })

  test("allows git status when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git status")
      expect(result.parsed).toBeNull()
    } finally {
      await cleanupRepo(repo)
    }
  })
})
