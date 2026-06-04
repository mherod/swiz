import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { statusCommand } from "./status.ts"

const SWIZ_ENTRY = join(import.meta.dir, "../../index.ts")

/** Run `bun run index.ts status` with a controlled environment and return stdout. */
async function runStatus(envOverrides: Record<string, string | undefined>): Promise<string> {
  // Start from a clean base stripped of all agent detection vars so tests don't
  // bleed into each other when running inside a real agent (e.g. CLAUDECODE=1).
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v
  }
  // Strip all known agent env vars so the detection state is deterministic
  for (const key of [
    "CLAUDECODE",
    "GEMINI_CLI",
    "GEMINI_PROJECT_DIR",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_THREAD_ID",
  ]) {
    delete base[key]
  }
  // Apply caller-supplied overrides (undefined = delete)
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete base[k]
    } else {
      base[k] = v
    }
  }

  const proc = Bun.spawn(["bun", "run", SWIZ_ENTRY, "status", "--no-health"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, SWIZ_STATUS_SKIP_CI: "1" },
  })
  const [output] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return output
}

describe("swiz status — agent environment detection", () => {
  it("shows 'Running inside: Claude Code' when CLAUDECODE=1", async () => {
    const out = await runStatus({ CLAUDECODE: "1" })
    expect(out).toContain("Running inside:")
    expect(out).toContain("Claude Code")
  })

  it("shows 'Running inside: Gemini CLI' when GEMINI_CLI=1", async () => {
    const out = await runStatus({ GEMINI_CLI: "1" })
    expect(out).toContain("Running inside:")
    expect(out).toContain("Gemini CLI")
  })

  it("shows 'Running inside: Gemini CLI' when GEMINI_PROJECT_DIR is set", async () => {
    const out = await runStatus({ GEMINI_PROJECT_DIR: "/tmp/proj" })
    expect(out).toContain("Running inside:")
    expect(out).toContain("Gemini CLI")
  })

  it("shows 'Running inside: Codex CLI' when CODEX_MANAGED_BY_NPM=1", async () => {
    const out = await runStatus({ CODEX_MANAGED_BY_NPM: "1" })
    expect(out).toContain("Running inside:")
    expect(out).toContain("Codex CLI")
  })

  it("shows 'Running inside: Codex CLI' when CODEX_THREAD_ID is set", async () => {
    const out = await runStatus({ CODEX_THREAD_ID: "019ca65a-aa4f-7981-9d70-fed49c3c0621" })
    expect(out).toContain("Running inside:")
    expect(out).toContain("Codex CLI")
  })

  it("omits 'Running inside' line when no agent vars are set", async () => {
    const out = await runStatus({})
    expect(out).not.toContain("Running inside:")
  })

  it("Claude takes priority over Gemini when both vars are set", async () => {
    const out = await runStatus({ CLAUDECODE: "1", GEMINI_CLI: "1" })
    // The "Running inside:" line must name Claude Code, not Gemini CLI
    const runningInsideLine = out.split("\n").find((l) => l.includes("Running inside:")) ?? ""
    expect(runningInsideLine).toContain("Claude Code")
    expect(runningInsideLine).not.toContain("Gemini CLI")
  })

  it("outputs 'swiz status' header regardless of agent", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { GEMINI_CLI: "1" }, {}]) {
      const out = await runStatus(env)
      expect(out).toContain("swiz status")
    }
  }, 15_000)
})

describe("swiz status — test and lint execution stats rendering", () => {
  let tempDir: string

  async function runStatusInProcess(cwd: string, args: string[] = []): Promise<string> {
    const originalCwd = process.cwd
    process.cwd = () => cwd
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    let output = ""
    try {
      await statusCommand.run(args)
      output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    } finally {
      process.cwd = originalCwd
      consoleLogSpy.mockRestore()
    }
    const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
    return output.replace(ansiRegex, "")
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "swiz-status-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("outputs 'no runs recorded' when no stats files exist", async () => {
    const out = await runStatusInProcess(tempDir)
    expect(out).toContain("Avg Test:  no runs recorded")
    expect(out).toContain("Avg Lint:  no runs recorded")
  })

  it("renders stats when they exist (negligible test, significant lint)", async () => {
    await mkdir(join(tempDir, ".swiz"), { recursive: true })

    // Test stats: total 4000ms across 2 runs (average 2.00s < 5s -> negligible)
    await Bun.write(
      join(tempDir, ".swiz", "test-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 4000, count: 2 })
    )

    // Lint stats: total 18000ms across 3 runs (average 6.00s >= 5s -> significant)
    await Bun.write(
      join(tempDir, ".swiz", "lint-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 18000, count: 3 })
    )

    const out = await runStatusInProcess(tempDir)
    expect(out).toContain("Avg Test:  2.00s (based on 2 runs) [negligible]")
    expect(out).toContain("Avg Lint:  6.00s (based on 3 runs) [significant]")
  })

  it("renders stats when they exist (significant test, negligible lint)", async () => {
    await mkdir(join(tempDir, ".swiz"), { recursive: true })

    // Test stats: total 6000ms across 1 run (average 6.00s >= 5s -> significant)
    await Bun.write(
      join(tempDir, ".swiz", "test-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 6000, count: 1 })
    )

    // Lint stats: total 3000ms across 3 runs (average 1.00s < 5s -> negligible)
    await Bun.write(
      join(tempDir, ".swiz", "lint-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 3000, count: 3 })
    )

    const out = await runStatusInProcess(tempDir)
    expect(out).toContain("Avg Test:  6.00s (based on 1 run) [significant]")
    expect(out).toContain("Avg Lint:  1.00s (based on 3 runs) [negligible]")
  })

  it("outputs JSON with correct stats structure when --json is passed", async () => {
    await mkdir(join(tempDir, ".swiz"), { recursive: true })

    await Bun.write(
      join(tempDir, ".swiz", "test-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 4000, count: 2 })
    )

    await Bun.write(
      join(tempDir, ".swiz", "lint-execution-stats.json"),
      JSON.stringify({ totalTimeMs: 18000, count: 3 })
    )

    const out = await runStatusInProcess(tempDir, ["--json"])
    const parsed = JSON.parse(out)

    expect(parsed.testStats).toEqual({
      totalTimeMs: 4000,
      count: 2,
      averageMs: 2000,
      assessment: "negligible",
    })
    expect(parsed.lintStats).toEqual({
      totalTimeMs: 18000,
      count: 3,
      averageMs: 6000,
      assessment: "significant",
    })
  })
})
