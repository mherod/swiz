import { describe, expect, it } from "bun:test"
import { resolveReplayTarget } from "./issue-store-replay.ts"
import type { RepositoryCapability } from "./repository-capability.ts"

function capability(overrides: Partial<RepositoryCapability> = {}): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "abc123",
    isRepo: true,
    repoSlug: "mherod/swiz",
    hasGhCli: true,
    resolvedAt: 0,
    ...overrides,
  }
}

describe("resolveReplayTarget", () => {
  it("reuses a verified capability instead of re-probing", async () => {
    const target = await resolveReplayTarget("/repo/subdir", capability())

    // Canonical root wins over the raw cwd the caller happened to pass.
    expect(target).toEqual({ dir: "/repo", slug: "mherod/swiz" })
  })

  it("declines when the capability reports no git repository", async () => {
    expect(await resolveReplayTarget("/plain", capability({ isRepo: false }))).toBeNull()
  })

  it("declines when the capability reports no gh CLI", async () => {
    expect(await resolveReplayTarget("/repo", capability({ hasGhCli: false }))).toBeNull()
  })

  it("declines when the repository has no GitHub slug", async () => {
    expect(await resolveReplayTarget("/repo", capability({ repoSlug: null }))).toBeNull()
  })
})
