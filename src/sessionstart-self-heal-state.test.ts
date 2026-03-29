import { describe, expect, it } from "bun:test"
import { useTempDir } from "./utils/test-utils.ts"

const _tmp = useTempDir("swiz-self-heal-")

describe("sessionstart-self-heal-state", () => {
  async function run(home: string, fn: string): Promise<string> {
    const script = `
      import {
        isSessionstartSelfHealPaused,
        pauseSessionstartSelfHeal,
        resumeSessionstartSelfHeal,
      } from "./src/sessionstart-self-heal-state.ts"
      const result = await ${fn}
      console.log(JSON.stringify(result))
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  }

  it("pauses after full removal and resumes after hook reinstall signal", async () => {
    const home = await _tmp.create()
    expect(await run(home, "isSessionstartSelfHealPaused()")).toBe("false")
    await run(home, "pauseSessionstartSelfHeal()")
    expect(await run(home, "isSessionstartSelfHealPaused()")).toBe("true")
    await run(home, "resumeSessionstartSelfHeal()")
    expect(await run(home, "isSessionstartSelfHealPaused()")).toBe("false")
  })

  it("resume is idempotent when marker is absent", async () => {
    const home = await _tmp.create()
    await run(home, "resumeSessionstartSelfHeal()")
    expect(await run(home, "isSessionstartSelfHealPaused()")).toBe("false")
  })
})
