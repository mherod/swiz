import { describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { swizCeremonyDayFlagPath } from "../src/temp-paths.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateSessionstartMorningStandupPrompt } from "./sessionstart-morning-standup-prompt.ts"

const tmp = useTempDir("swiz-morning-standup-test-")

function todaySentinel(): string {
  return swizCeremonyDayFlagPath("morning-standup", new Date().toISOString().slice(0, 10))
}

async function initGitRepo(dir: string): Promise<void> {
  const init = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(init.stdout).text(), new Response(init.stderr).text()])
  await init.exited
}

const BASE_INPUT = { session_id: "test-sess" }

describe("sessionstart-morning-standup-prompt", () => {
  test("non-git dir → no output", async () => {
    const dir = await tmp.create()
    const result = await evaluateSessionstartMorningStandupPrompt({ ...BASE_INPUT, cwd: dir })
    expect(result).toEqual({})
  })

  test("sentinel present today → no output", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const sentinel = todaySentinel()
    await writeFile(sentinel, "")
    try {
      const result = await evaluateSessionstartMorningStandupPrompt({ ...BASE_INPUT, cwd: dir })
      expect(result).toEqual({})
    } finally {
      await rm(sentinel, { force: true })
    }
  })

  test("no sentinel → fires with morning-standup suggestion and writes sentinel", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const sentinel = todaySentinel()
    await rm(sentinel, { force: true })
    try {
      const result = (await evaluateSessionstartMorningStandupPrompt({
        ...BASE_INPUT,
        cwd: dir,
      })) as Record<string, any>
      const ctx: string =
        (result?.hookSpecificOutput?.additionalContext as string | undefined) ??
        (result?.systemMessage as string | undefined) ??
        ""
      expect(ctx.length).toBeGreaterThan(0)
      expect(ctx).toMatch(/morning.standup/i)
    } finally {
      await rm(sentinel, { force: true })
    }
  })
})
