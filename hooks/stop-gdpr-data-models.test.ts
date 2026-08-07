import { describe, expect, test } from "bun:test"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateStopGdprDataModels } from "./stop-gdpr-data-models.ts"

const gdprProjects = useTempDir("swiz-gdpr-capability-")

function gdprCapability(cwd: string, isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: cwd,
    repoKey: "gdpr-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("stop-gdpr-data-models repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    const cwd = await gdprProjects.create()
    let fallbackCalls = 0
    const input = {
      cwd,
      session_id: "gdpr-non-repo",
      _repositoryCapability: gdprCapability(cwd, false),
    } as StopHookInput

    const output = await evaluateStopGdprDataModels(input, () => {
      fallbackCalls++
      return Promise.resolve(true)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("matches standalone fallback behavior for repository membership", async () => {
    const cwd = await gdprProjects.create()
    const baseInput = { cwd, session_id: "gdpr-repo" } as StopHookInput
    let enrichedFallbackCalls = 0
    let standaloneFallbackCalls = 0

    const enriched = await evaluateStopGdprDataModels(
      { ...baseInput, _repositoryCapability: gdprCapability(cwd, true) } as StopHookInput,
      () => {
        enrichedFallbackCalls++
        return Promise.resolve(false)
      }
    )
    const standalone = await evaluateStopGdprDataModels(baseInput, () => {
      standaloneFallbackCalls++
      return Promise.resolve(true)
    })

    expect(enriched).toEqual(standalone)
    expect(enrichedFallbackCalls).toBe(0)
    expect(standaloneFallbackCalls).toBe(1)
  })
})
