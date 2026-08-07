import { describe, expect, test } from "bun:test"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateStopDependabotPrs } from "./stop-dependabot-prs.ts"

const dependabotProjects = useTempDir("swiz-dependabot-capability-")

function dependabotCapability(cwd: string, isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: cwd,
    repoKey: "dependabot-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("stop-dependabot-prs repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    const cwd = await dependabotProjects.create()
    let fallbackCalls = 0
    const input = {
      cwd,
      session_id: "dependabot-non-repo",
      _repositoryCapability: dependabotCapability(cwd, false),
    } as StopHookInput

    const output = await evaluateStopDependabotPrs(input, () => {
      fallbackCalls++
      return Promise.resolve(true)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("matches standalone fallback behavior for repository membership", async () => {
    const cwd = await dependabotProjects.create()
    const baseInput = { cwd, session_id: "dependabot-repo" } as StopHookInput
    let enrichedFallbackCalls = 0
    let standaloneFallbackCalls = 0

    const enriched = await evaluateStopDependabotPrs(
      { ...baseInput, _repositoryCapability: dependabotCapability(cwd, true) } as StopHookInput,
      () => {
        enrichedFallbackCalls++
        return Promise.resolve(false)
      }
    )
    const standalone = await evaluateStopDependabotPrs(baseInput, () => {
      standaloneFallbackCalls++
      return Promise.resolve(true)
    })

    expect(enriched).toEqual(standalone)
    expect(enrichedFallbackCalls).toBe(0)
    expect(standaloneFallbackCalls).toBe(1)
  })
})
