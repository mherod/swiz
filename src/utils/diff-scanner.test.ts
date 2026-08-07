import { describe, expect, test } from "bun:test"
import type { RepositoryCapability } from "../repository-capability.ts"
import { evaluateDiffScanStopHook } from "./diff-scanner.ts"

const OPTIONS = {
  diffPathspecs: ["*.ts"],
  scanDiff: () => null,
  buildBlockMessage: () => "blocked",
}

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "diff-scanner-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("diff-scanner repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    let fallbackCalls = 0
    const output = await evaluateDiffScanStopHook(
      OPTIONS,
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
    const output = await evaluateDiffScanStopHook(OPTIONS, { cwd: "/repo" }, () => {
      fallbackCalls++
      return Promise.resolve(false)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(1)
  })

  test("preserves malformed-input rejection", async () => {
    expect(evaluateDiffScanStopHook(OPTIONS, null)).rejects.toThrow()
  })
})
