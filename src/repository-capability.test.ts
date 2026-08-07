import { beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import {
  isGitRepoForHookPayload,
  REPOSITORY_CAPABILITY_TTL_MS,
  type RepositoryCapability,
  type RepositoryCapabilityProbes,
  resetRepositoryCapabilityCacheForTests,
  resolveRepositoryCapability,
} from "./repository-capability.ts"

interface CountingProbes {
  probes: RepositoryCapabilityProbes
  counts: { isGitRepo: number; getRepoSlug: number; hasGhCli: number }
}

function countingProbes(
  overrides: Partial<RepositoryCapabilityProbes> = {},
  delayMs = 0
): CountingProbes {
  const counts = { isGitRepo: 0, getRepoSlug: 0, hasGhCli: 0 }
  const probes: RepositoryCapabilityProbes = {
    isGitRepo: async (dir) => {
      counts.isGitRepo++
      if (delayMs > 0) await Bun.sleep(delayMs)
      return overrides.isGitRepo ? overrides.isGitRepo(dir) : true
    },
    getRepoSlug: async (dir) => {
      counts.getRepoSlug++
      return overrides.getRepoSlug ? overrides.getRepoSlug(dir) : "mherod/swiz"
    },
    hasGhCli: () => {
      counts.hasGhCli++
      return overrides.hasGhCli ? overrides.hasGhCli() : true
    },
  }
  return { probes, counts }
}

describe("resolveRepositoryCapability", () => {
  beforeEach(() => {
    resetRepositoryCapabilityCacheForTests()
  })

  it("performs one repository subprocess per uncached project request", async () => {
    const { probes, counts } = countingProbes()

    const first = await resolveRepositoryCapability("/repo", { probes })
    const second = await resolveRepositoryCapability("/repo", { probes })
    const third = await resolveRepositoryCapability("/repo", { probes })

    expect(counts.isGitRepo).toBe(1)
    expect(first.isRepo).toBe(true)
    expect(first.repoSlug).toBe("mherod/swiz")
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it("deduplicates concurrent resolves for the same project", async () => {
    const { probes, counts } = countingProbes({}, 5)

    const results = await Promise.all([
      resolveRepositoryCapability("/repo", { probes }),
      resolveRepositoryCapability("/repo", { probes }),
      resolveRepositoryCapability("/repo", { probes }),
      resolveRepositoryCapability("/repo", { probes }),
    ])

    expect(counts.isGitRepo).toBe(1)
    expect(new Set(results).size).toBe(1)
  })

  it("keys separate projects independently", async () => {
    const { probes, counts } = countingProbes({
      isGitRepo: async (dir) => dir !== "/not-a-repo",
    })

    const repo = await resolveRepositoryCapability("/repo", { probes })
    const plain = await resolveRepositoryCapability("/not-a-repo", { probes })

    expect(counts.isGitRepo).toBe(2)
    expect(repo.isRepo).toBe(true)
    expect(plain.isRepo).toBe(false)
  })

  it("skips the remote lookup entirely outside a repository", async () => {
    const { probes, counts } = countingProbes({ isGitRepo: async () => false })

    const capability = await resolveRepositoryCapability("/plain-dir", { probes })

    expect(capability.isRepo).toBe(false)
    expect(capability.repoSlug).toBeNull()
    expect(counts.getRepoSlug).toBe(0)
  })

  it("reports a missing gh CLI without failing resolution", async () => {
    const { probes } = countingProbes({ hasGhCli: () => false })

    const capability = await resolveRepositoryCapability("/repo", { probes })

    expect(capability.hasGhCli).toBe(false)
    expect(capability.isRepo).toBe(true)
  })

  it("re-probes after the TTL elapses", async () => {
    let clock = 0
    resetRepositoryCapabilityCacheForTests({ ttlMs: 50, now: () => clock })
    const { probes, counts } = countingProbes()

    await resolveRepositoryCapability("/repo", { probes })
    clock += 49
    await resolveRepositoryCapability("/repo", { probes })
    expect(counts.isGitRepo).toBe(1)

    clock += 1
    await resolveRepositoryCapability("/repo", { probes })
    expect(counts.isGitRepo).toBe(2)
  })

  it("forces a fresh probe when asked", async () => {
    const { probes, counts } = countingProbes()

    await resolveRepositoryCapability("/repo", { probes })
    await resolveRepositoryCapability("/repo", { probes, forceRefresh: true })

    expect(counts.isGitRepo).toBe(2)
  })

  it("fails open to a non-repo capability when a probe throws", async () => {
    const probes: RepositoryCapabilityProbes = {
      isGitRepo: async () => {
        throw new Error("git unavailable")
      },
      getRepoSlug: async () => null,
      hasGhCli: () => true,
    }

    const capability = await resolveRepositoryCapability("/repo", { probes })

    expect(capability.isRepo).toBe(false)
    expect(capability.repoSlug).toBeNull()
    expect(capability.canonicalRoot).toBe("/repo")
  })

  it("uses a short bounded default TTL", () => {
    expect(REPOSITORY_CAPABILITY_TTL_MS).toBeGreaterThan(0)
    expect(REPOSITORY_CAPABILITY_TTL_MS).toBeLessThanOrEqual(60_000)
  })
})

const repositoryCapability = (isRepo: boolean): RepositoryCapability => ({
  canonicalRoot: "/repo",
  repoKey: "repo-key",
  isRepo,
  repoSlug: isRepo ? "owner/repo" : null,
  hasGhCli: true,
  resolvedAt: Date.now(),
})

describe("isGitRepoForHookPayload", () => {
  for (const expected of [true, false]) {
    it(`reuses dispatcher-verified membership when isRepo=${expected}`, async () => {
      let fallbackCalls = 0
      const result = await isGitRepoForHookPayload(
        { _repositoryCapability: repositoryCapability(expected) },
        "/repo",
        async () => {
          fallbackCalls++
          return !expected
        }
      )

      expect(result).toBe(expected)
      expect(fallbackCalls).toBe(0)
    })
  }

  for (const [name, input] of [
    ["absent", {}],
    ["malformed", { _repositoryCapability: { isRepo: true } }],
  ] as const) {
    it(`uses the canonical fallback when capability is ${name}`, async () => {
      const seenCwds: string[] = []
      const result = await isGitRepoForHookPayload(input, "malformed-cwd", async (cwd) => {
        seenCwds.push(cwd)
        return true
      })

      expect(result).toBe(true)
      expect(seenCwds).toEqual(["malformed-cwd"])
    })
  }

  it("is the repository-membership boundary for every issue #753 gate", async () => {
    const hookFiles = [
      "pretooluse-pr-changes-branch-guard.ts",
      "pretooluse-task-governance.ts",
      "pretooluse-sandboxed-edits.ts",
      "pretooluse-repeated-lint-test.ts",
      "pretooluse-pr-comment-read-gate.ts",
      "pretooluse-no-phantom-task-completion.ts",
      "pretooluse-branch-intent-gate.ts",
      "pretooluse-pr-head-checkout-gate.ts",
      "pretooluse-update-memory-enforcement.ts",
      "pretooluse-issue-workflow-gate.ts",
      "pretooluse-block-preexisting-dismissals.ts",
      "pretooluse-dirty-worktree-gate.ts",
      "pretooluse-trunk-mode-branch-gate.ts",
    ]

    for (const hookFile of hookFiles) {
      const source = await Bun.file(join(process.cwd(), "hooks", hookFile)).text()
      expect(source, hookFile).toContain("isGitRepoForHookPayload(")
    }
  })

  it("is the repository-membership boundary for every issue #754 workflow stop hook", async () => {
    const hookFiles = [
      "stop-ship-checklist/context.ts",
      "stop-git-status/context.ts",
      "stop-lockfile-drift/context.ts",
      "stop-non-default-branch.ts",
      "stop-upstream-branch-count.ts",
      "stop-branch-conflicts/context.ts",
      "stop-pr-feedback/context.ts",
      "stop-pr-changes-requested/context.ts",
      "stop-pr-description/context.ts",
      "stop-personal-repo-issues/context.ts",
    ]

    for (const hookFile of hookFiles) {
      const source = await Bun.file(join(process.cwd(), "hooks", hookFile)).text()
      expect(source, hookFile).toContain("isGitRepoForHookPayload(")
      expect(source, hookFile).not.toMatch(/\bisGitRepo\(/)

      for (const isRepo of [true, false]) {
        let fallbackCalls = 0
        const result = await isGitRepoForHookPayload(
          { _repositoryCapability: repositoryCapability(isRepo) },
          hookFile,
          async () => {
            fallbackCalls++
            return !isRepo
          }
        )

        expect(result, `${hookFile}: enriched isRepo=${isRepo}`).toBe(isRepo)
        expect(fallbackCalls, `${hookFile}: enriched fallback calls`).toBe(0)
      }

      const fallbackCwds: string[] = []
      const fallbackResult = await isGitRepoForHookPayload({}, hookFile, async (cwd) => {
        fallbackCwds.push(cwd)
        return true
      })
      expect(fallbackResult, `${hookFile}: standalone fallback result`).toBe(true)
      expect(fallbackCwds, `${hookFile}: standalone fallback cwd`).toEqual([hookFile])
    }
  })

  it("is the repository-membership boundary for every issue #755 governance stop hook", async () => {
    const hookFiles = [
      "stop-auto-continue.ts",
      "stop-auto-continue/changelog-staleness.ts",
      "stop-auto-continue/reviewing-state.ts",
      "stop-auto-continue/filler-suggestions.ts",
      "stop-memory-update-reminder.ts",
      "stop-memory-size.ts",
      "stop-secret-scanner.ts",
      "stop-gdpr-data-models.ts",
      "stop-todo-tracker.ts",
      "stop-dependabot-prs.ts",
      "stop-required-skills.ts",
      "stop-large-files.ts",
    ]

    for (const hookFile of hookFiles) {
      const source = await Bun.file(join(process.cwd(), "hooks", hookFile)).text()
      expect(source, hookFile).toContain("isGitRepoForHookPayload(")
      expect(source, hookFile).not.toMatch(/await\s+(?:deps\.)?isGitRepo\(/)

      for (const isRepo of [true, false]) {
        let fallbackCalls = 0
        const result = await isGitRepoForHookPayload(
          { _repositoryCapability: repositoryCapability(isRepo) },
          hookFile,
          async () => {
            fallbackCalls++
            return !isRepo
          }
        )

        expect(result, `${hookFile}: enriched isRepo=${isRepo}`).toBe(isRepo)
        expect(fallbackCalls, `${hookFile}: enriched fallback calls`).toBe(0)
      }

      const fallbackCwds: string[] = []
      const fallbackResult = await isGitRepoForHookPayload({}, hookFile, async (cwd) => {
        fallbackCwds.push(cwd)
        return true
      })
      expect(fallbackResult, `${hookFile}: standalone fallback result`).toBe(true)
      expect(fallbackCwds, `${hookFile}: standalone fallback cwd`).toEqual([hookFile])
    }
  })
})
