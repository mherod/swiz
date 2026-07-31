import { describe, expect, test } from "bun:test"
import type { ProjectIdentityResolution } from "../../../project-identity.ts"
import type { RepositoryCapability } from "../../../repository-capability.ts"
import { RepositoryCapabilityCache } from "./repository-capability-cache.ts"

function identity(root: string, key = root): ProjectIdentityResolution {
  return { canonicalRoot: root, repoKey: key, isGitRepo: true }
}

function capability(project: ProjectIdentityResolution): RepositoryCapability {
  return { ...project, repoSlug: "owner/repo" }
}

describe("RepositoryCapabilityCache", () => {
  test("coalesces concurrent uncached resolution by project identity", async () => {
    let resolveCount = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = new RepositoryCapabilityCache({
      resolveIdentity: async () => identity("/repo"),
      resolveCapability: async (project) => {
        resolveCount++
        await gate
        return capability(project)
      },
    })

    const first = cache.get("/repo")
    const second = cache.get("/repo/src")
    await Promise.resolve()
    expect(resolveCount).toBe(1)
    release?.()

    expect(await first).toEqual(await second)
    expect(cache.size).toBe(1)
  })

  test("refreshes after TTL expiry", async () => {
    let now = 1_000
    let resolveCount = 0
    const cache = new RepositoryCapabilityCache({
      ttlMs: 100,
      now: () => now,
      resolveIdentity: async () => identity("/repo"),
      resolveCapability: async (project) => {
        resolveCount++
        return capability(project)
      },
    })

    await cache.get("/repo")
    now += 99
    await cache.get("/repo")
    expect(resolveCount).toBe(1)

    now += 1
    await cache.get("/repo")
    expect(resolveCount).toBe(2)
  })

  test("bounds entries and treats an identity change as a cache miss", async () => {
    let version = "v1"
    let resolveCount = 0
    const cache = new RepositoryCapabilityCache({
      maxEntries: 2,
      resolveIdentity: async (cwd) => identity(cwd, `${cwd}:${version}`),
      resolveCapability: async (project) => {
        resolveCount++
        return capability(project)
      },
    })

    await cache.get("/one")
    await cache.get("/two")
    await cache.get("/three")
    expect(cache.size).toBe(2)

    version = "v2"
    await cache.get("/three")
    expect(resolveCount).toBe(4)
    expect(cache.size).toBe(2)
  })

  test("invalidates a project through a nested path", async () => {
    const cache = new RepositoryCapabilityCache({
      resolveIdentity: async () => identity("/repo"),
      resolveCapability: async (project) => capability(project),
    })
    await cache.get("/repo/src")

    cache.invalidateProject("/repo/src/nested")

    expect(cache.size).toBe(0)
  })
})
