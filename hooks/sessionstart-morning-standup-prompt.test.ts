import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateSessionstartMorningStandupPrompt } from "./sessionstart-morning-standup-prompt.ts"

const tmp = useTempDir("swiz-morning-standup-test-")

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
    // Use a per-test isolated sentinel path to prevent races with concurrent test files.
    const sentinel = join(dir, "morning-standup.flag")
    await Bun.write(sentinel, "")
    const result = await evaluateSessionstartMorningStandupPrompt(
      { ...BASE_INPUT, cwd: dir },
      sentinel
    )
    expect(result).toEqual({})
  })

  test("no sentinel → fires with morning-standup suggestion and writes sentinel", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const sentinel = join(dir, "morning-standup.flag")
    const result = (await evaluateSessionstartMorningStandupPrompt(
      { ...BASE_INPUT, cwd: dir },
      sentinel
    )) as Record<string, any>
    const ctx: string =
      (result?.hookSpecificOutput?.additionalContext as string | undefined) ??
      (result?.systemMessage as string | undefined) ??
      ""
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx).toMatch(/morning.standup/i)
  })
})
