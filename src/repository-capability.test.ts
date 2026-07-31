import { beforeEach, describe, expect, it } from "bun:test"
import {
  REPOSITORY_CAPABILITY_TTL_MS,
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

  })
})
