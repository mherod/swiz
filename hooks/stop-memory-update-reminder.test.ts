import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateStopMemoryUpdateReminder } from "./stop-memory-update-reminder.ts"

const memoryHomes = useTempDir("swiz-memory-reminder-capability-")

function memoryCapability(cwd: string, isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: cwd,
    repoKey: "memory-reminder-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("stop-memory-update-reminder repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    const cwd = await memoryHomes.create()
    let fallbackCalls = 0
    const input = {
      cwd,
      session_id: "memory-reminder-non-repo",
      _repositoryCapability: memoryCapability(cwd, false),
    } as StopHookInput

    const output = await evaluateStopMemoryUpdateReminder(input, () => {
      fallbackCalls++
      return Promise.resolve(true)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("matches standalone fallback behavior for repository membership", async () => {
    const cwd = await memoryHomes.create()
    await Bun.write(join(cwd, "CLAUDE.md"), "# Recent memory\n")
    const baseInput = { cwd, session_id: "memory-reminder-repo" } as StopHookInput
    let enrichedFallbackCalls = 0
    let standaloneFallbackCalls = 0

    const enriched = await evaluateStopMemoryUpdateReminder(
      { ...baseInput, _repositoryCapability: memoryCapability(cwd, true) } as StopHookInput,
      () => {
        enrichedFallbackCalls++
        return Promise.resolve(false)
      }
    )
    const standalone = await evaluateStopMemoryUpdateReminder(baseInput, () => {
      standaloneFallbackCalls++
      return Promise.resolve(true)
    })

    expect(enriched).toEqual(standalone)
    expect(enrichedFallbackCalls).toBe(0)
    expect(standaloneFallbackCalls).toBe(1)
  })
})
