import { describe, expect, test } from "bun:test"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { evaluateSessionstartHealthSnapshot } from "./sessionstart-health-snapshot.ts"

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "session-health-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("sessionstart-health-snapshot repository capability", () => {
  test("matches standalone non-repository behavior without enriched fallback", async () => {
    let enrichedFallbackCalls = 0
    let standaloneFallbackCalls = 0

    const enriched = await evaluateSessionstartHealthSnapshot(
      {
        cwd: "/repo",
        _repositoryCapability: repositoryCapability(false),
      },
      () => {
        enrichedFallbackCalls++
        return Promise.resolve(true)
      }
    )
    const standalone = await evaluateSessionstartHealthSnapshot({ cwd: "/repo" }, () => {
      standaloneFallbackCalls++
      return Promise.resolve(false)
    })

    expect(enriched).toEqual(standalone)
    expect(enrichedFallbackCalls).toBe(0)
    expect(standaloneFallbackCalls).toBe(1)
  })
})
