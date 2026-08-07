import { describe, expect, test } from "bun:test"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { evaluatePrecommitStagedValidation } from "./precommit-staged-validation.ts"

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "precommit-validation-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("precommit-staged-validation repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    let fallbackCalls = 0
    const output = await evaluatePrecommitStagedValidation(
      {
        cwd: "/repo",
        _repositoryCapability: repositoryCapability(false),
      },
      () => {
        fallbackCalls++
        return Promise.resolve(true)
      }
    )

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("retains the standalone non-repository fallback", async () => {
    let fallbackCalls = 0
    const output = await evaluatePrecommitStagedValidation({ cwd: "/repo" }, () => {
      fallbackCalls++
      return Promise.resolve(false)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(1)
  })

  test("keeps malformed scheduled input fail-open", async () => {
    expect(await evaluatePrecommitStagedValidation(null)).toEqual({})
  })
})
