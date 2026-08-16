import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const INDEX_PATH = join(import.meta.dir, "../../index.ts")

describe("index.ts invocation guard", () => {
  test("direct invocation without SWIZ_DIRECT is blocked", async () => {
    const proc = Bun.spawn(["bun", "run", INDEX_PATH, "help"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SWIZ_DIRECT: undefined,
      },
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("Error: swiz must be invoked via the globally linked command.")
    expect(stderr).toContain("Run: swiz <command>")
  })

  test("direct invocation with SWIZ_DIRECT=1 succeeds", async () => {
    const proc = Bun.spawn(["bun", "run", INDEX_PATH, "help"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SWIZ_DIRECT: "1",
      },
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(0)
    expect(stdout).toContain("swiz - CLI toolkit")
    expect(stderr).toBe("")
  })
})
