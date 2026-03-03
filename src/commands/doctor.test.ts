import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-doctor-test-"))
  tempDirs.push(dir)
  return dir
}

async function runDoctor(
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "doctor"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

describe("swiz doctor", () => {
  test("reports Bun runtime as passing", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Bun runtime")
    expect(result.stdout).toMatch(/Bun runtime.*v\d+/)
  })

  test("reports hook scripts check", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Hook scripts")
    // All manifest scripts should exist in the repo
    expect(result.stdout).toMatch(/Hook scripts.*manifest scripts found/)
  })

  test("reports GitHub CLI auth status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("GitHub CLI auth")
  })

  test("reports TTS backend status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("TTS backend")
  })

  test("reports swiz settings status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Swiz settings")
  })

  test("detects malformed agent settings as failure", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, "settings.json"), "{ invalid json !!!")
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code settings")
    expect(result.stdout).toContain("malformed JSON")
  })

  test("shows summary counts", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toMatch(/\d+ passed/)
  })

  test("exits zero when no hard failures", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    // Missing agent binaries and settings are warnings, not failures
    // In a clean repo, hook scripts should all exist
    if (!result.stdout.includes("failed")) {
      expect(result.exitCode).toBe(0)
    }
  })

  test("exits non-zero when hard failures exist", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    // Write malformed JSON to trigger a failure
    await writeFile(join(claudeDir, "settings.json"), "not json at all")
    const result = await runDoctor(home)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("check(s) failed")
  })

  test("reports agent binary checks for all agents", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code binary")
    expect(result.stdout).toContain("Cursor binary")
    expect(result.stdout).toContain("Gemini CLI binary")
    expect(result.stdout).toContain("Codex CLI binary")
  })
})
