import { describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { swizCeremonyDayFlagPath } from "../src/temp-paths.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateSessionstartWeeklyRetroPrompt } from "./sessionstart-weekly-retro-prompt.ts"

const tmp = useTempDir("swiz-weekly-retro-test-")

function thisWeekSentinel(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  const weekKey = `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`
  return swizCeremonyDayFlagPath("weekly-retro", weekKey)
}

async function initGitRepo(dir: string): Promise<void> {
  const init = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(init.stdout).text(), new Response(init.stderr).text()])
  await init.exited
}

const BASE_INPUT = { session_id: "test-sess" }

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "weekly-retro-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("sessionstart-weekly-retro-prompt", () => {
  test("trusted non-repository enrichment avoids the fallback probe", async () => {
    let fallbackCalls = 0
    const result = await evaluateSessionstartWeeklyRetroPrompt(
      {
        ...BASE_INPUT,
        cwd: "/repo",
        _repositoryCapability: repositoryCapability(false),
      },
      () => {
        fallbackCalls++
        return Promise.resolve(true)
      }
    )

    expect(result).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("non-git dir → no output", async () => {
    const dir = await tmp.create()
    const result = await evaluateSessionstartWeeklyRetroPrompt({ ...BASE_INPUT, cwd: dir })
    expect(result).toEqual({})
  })

  test("sentinel present this week → no output", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const sentinel = thisWeekSentinel()
    await writeFile(sentinel, "")
    try {
      const result = await evaluateSessionstartWeeklyRetroPrompt({ ...BASE_INPUT, cwd: dir })
      expect(result).toEqual({})
    } finally {
      await rm(sentinel, { force: true })
    }
  })

  test("git repo with no remote → gh fails → no output", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const sentinel = thisWeekSentinel()
    await rm(sentinel, { force: true })
    try {
      // gh pr list fails with no remote configured → countMergedPrsInLast7Days returns 0
      const result = await evaluateSessionstartWeeklyRetroPrompt({ ...BASE_INPUT, cwd: dir })
      expect(result).toEqual({})
    } finally {
      await rm(sentinel, { force: true })
    }
  })
})
