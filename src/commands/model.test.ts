import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAUDE_MODEL_ALIASES } from "./model.ts"

const SWIZ_ENTRY = join(import.meta.dir, "../../index.ts")

function makeHome(): string {
  return join(tmpdir(), `swiz-model-${process.pid}-${randomBytes(6).toString("hex")}`)
}

async function runModel(
  home: string,
  proj: string,
  args: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const base: Record<string, string> = { ...process.env } as Record<string, string>
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  base.HOME = home
  base.SWIZ_DIRECT = "1"
  delete base.ANTHROPIC_MODEL

  const proc = Bun.spawn(["bun", "run", SWIZ_ENTRY, "model", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: base,
    cwd: proj,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, code: proc.exitCode }
}

describe("swiz model", () => {
  async function setup(): Promise<{ home: string; proj: string; cleanup: () => Promise<void> }> {
    const home = makeHome()
    const proj = join(home, "proj")
    await mkdir(join(home, ".claude"), { recursive: true })
    await mkdir(proj, { recursive: true })
    return { home, proj, cleanup: () => rm(home, { recursive: true, force: true }) }
  }

  test("show reports not set when no model keys exist", async () => {
    const { home, proj } = await setup()
    const { stdout, stderr, code } = await runModel(home, proj, ["show"])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("(not set)")
    expect(stdout).toContain("Effective (files only): (not set")
  })

  test("set writes top-level model to ~/.claude/settings.json", async () => {
    const { home, proj } = await setup()
    await writeFile(join(home, ".claude", "settings.json"), "{}\n", "utf8")
    const { stderr, code } = await runModel(home, proj, ["set", "opus"])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const raw = await readFile(join(home, ".claude", "settings.json"), "utf8")
    const j = JSON.parse(raw) as { model?: string }
    expect(j.model).toBe("opus")
  })

  test("shorthand single argument sets model", async () => {
    const { home, proj } = await setup()
    await writeFile(join(home, ".claude", "settings.json"), "{}\n", "utf8")
    const { code } = await runModel(home, proj, ["haiku"])
    expect(code).toBe(0)
    const raw = await readFile(join(home, ".claude", "settings.json"), "utf8")
    expect(JSON.parse(raw).model).toBe("haiku")
  })

  test("show lists effective from merged files", async () => {
    const { home, proj } = await setup()
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "sonnet" }),
      "utf8"
    )
    await mkdir(join(proj, ".claude"), { recursive: true })
    await writeFile(
      join(proj, ".claude", "settings.local.json"),
      JSON.stringify({ model: "opus" }),
      "utf8"
    )
    const { stdout, code } = await runModel(home, proj, ["show"])
    expect(code).toBe(0)
    expect(stdout).toContain("Global")
    expect(stdout).toContain("sonnet")
    expect(stdout).toContain("Local")
    expect(stdout).toContain("opus")
    expect(stdout).toContain("Effective (files only): opus")
  })

  test("unset removes model and creates .bak", async () => {
    const { home, proj } = await setup()
    const path = join(home, ".claude", "settings.json")
    await writeFile(path, JSON.stringify({ model: "opus", effortLevel: "high" }), "utf8")
    const { code } = await runModel(home, proj, ["unset", "--global"])
    expect(code).toBe(0)
    const j = JSON.parse(await readFile(path, "utf8")) as { model?: string; effortLevel?: string }
    expect(j.model).toBeUndefined()
    expect(j.effortLevel).toBe("high")
    const bak = await readFile(`${path}.bak`, "utf8")
    expect(bak).toContain("opus")
  })

  test("aliases prints documented alias list", async () => {
    const { home, proj } = await setup()
    const { stdout, code } = await runModel(home, proj, ["aliases"])
    expect(code).toBe(0)
    const lines = stdout.trim().split("\n").filter(Boolean)
    expect(lines).toEqual([...CLAUDE_MODEL_ALIASES])
  })

  test("project scope writes under --dir", async () => {
    const { home, proj } = await setup()
    const other = join(home, "other-proj")
    await mkdir(other, { recursive: true })
    const { code } = await runModel(home, proj, ["set", "sonnet", "--project", "--dir", other])
    expect(code).toBe(0)
    const p = join(other, ".claude", "settings.json")
    expect(JSON.parse(await readFile(p, "utf8")).model).toBe("sonnet")
  })
})
