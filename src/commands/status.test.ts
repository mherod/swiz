import { join } from "node:path"
import { describe, expect, it } from "vitest"

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

  const proc = Bun.spawn(["bun", "run", SWIZ_ENTRY, "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: base,
  })
  const output = await new Response(proc.stdout).text()
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
  })
})
