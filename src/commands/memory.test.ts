import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AGENTS } from "../agents.ts"
import { getMemorySources } from "./memory.ts"

const SWIZ_ENTRY = join(import.meta.dir, "../../index.ts")

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgent(id: string) {
  const agent = AGENTS.find((a) => a.id === id)
  if (!agent) throw new Error(`Unknown agent: ${id}`)
  return agent
}

function cleanEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v
  }
  for (const key of [
    "CLAUDECODE",
    "GEMINI_CLI",
    "GEMINI_PROJECT_DIR",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_THREAD_ID",
  ]) {
    delete base[key]
  }
  return base
}

async function runMemory(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = cleanEnv()
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k]
    } else {
      env[k] = v
    }
  }

  const proc = Bun.spawn(["bun", "run", SWIZ_ENTRY, "memory", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 }
}

// ─── Unit tests: getMemorySources ────────────────────────────────────────────

describe("getMemorySources", () => {
  it("returns Claude sources in precedence order", () => {
    const sources = getMemorySources(getAgent("claude"), "/tmp/myproject")
    expect(sources.length).toBeGreaterThanOrEqual(3)
    expect(sources[0]?.label).toBe("Project rules")
    expect(sources[0]?.path).toContain("CLAUDE.md")
    expect(sources[1]?.label).toBe("Project memory")
    expect(sources[1]?.path).toContain("MEMORY.md")
    // Last source should be global
    const last = sources[sources.length - 1]
    expect(last?.label).toBe("Global rules")
    expect(last?.path).toContain(".claude/CLAUDE.md")
  })

  it("returns Cursor sources including .cursorrules", () => {
    const sources = getMemorySources(getAgent("cursor"), "/tmp/myproject")
    expect(sources.length).toBeGreaterThanOrEqual(2)
    expect(sources[0]?.label).toContain(".cursorrules")
  })

  it("returns Gemini sources with project and global", () => {
    const sources = getMemorySources(getAgent("gemini"), "/tmp/myproject")
    expect(sources.length).toBe(3)
    expect(sources[0]?.path).toContain("GEMINI.md")
    expect(sources[2]?.path).toContain(".gemini/GEMINI.md")
  })

  it("returns Codex sources with AGENTS.md and instructions", () => {
    const sources = getMemorySources(getAgent("codex"), "/tmp/myproject")
    expect(sources.length).toBe(4)
    expect(sources[0]?.path).toContain("AGENTS.md")
    expect(sources[1]?.path).toContain(".codex/AGENTS.md")
    expect(sources[2]?.path).toContain("instructions.md")
    expect(sources[3]?.path).toContain("history.jsonl")
  })

  it("includes additional memory files for Claude projects", () => {
    // Create a temp dir with extra memory files
    const tmpHome = join(tmpdir(), `swiz-mem-test-${Date.now()}`)
    const projectKey = "-tmp-memproj"
    const memDir = join(tmpHome, ".claude", "projects", projectKey, "memory")
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, "MEMORY.md"), "# Memory\n")
    writeFileSync(join(memDir, "debugging.md"), "# Debug notes\n")
    writeFileSync(join(memDir, "patterns.md"), "# Patterns\n")

    // Override HOME for agent resolution
    const origHome = process.env.HOME
    process.env.HOME = tmpHome
    try {
      const sources = getMemorySources(getAgent("claude"), "/tmp/memproj")
      const labels = sources.map((s) => s.label)
      expect(labels).toContain("Project memory (debugging.md)")
      expect(labels).toContain("Project memory (patterns.md)")
    } finally {
      process.env.HOME = origHome
    }
  })

  it("handles Cursor project with .cursor/rules directory", () => {
    const tmpDir = join(tmpdir(), `swiz-cursor-test-${Date.now()}`)
    const rulesDir = join(tmpDir, ".cursor", "rules")
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, "style.mdc"), "# Style\n")
    writeFileSync(join(rulesDir, "testing.md"), "# Testing\n")

    const sources = getMemorySources(getAgent("cursor"), tmpDir)
    const labels = sources.map((s) => s.label)
    expect(labels).toContain("Project rule (style.mdc)")
    expect(labels).toContain("Project rule (testing.md)")
  })
})

// ─── CLI integration tests ──────────────────────────────────────────────────

describe("swiz memory CLI", () => {
  it("shows Claude hierarchy when CLAUDECODE=1", async () => {
    const { stdout } = await runMemory([], { CLAUDECODE: "1" })
    expect(stdout).toContain("Claude Code")
    expect(stdout).toContain("Rule hierarchy")
    expect(stdout).toContain("Project rules")
    expect(stdout).toContain("Global rules")
  })

  it("shows Gemini hierarchy with --gemini flag", async () => {
    const { stdout } = await runMemory(["--gemini"])
    expect(stdout).toContain("Gemini CLI")
    expect(stdout).toContain("GEMINI.md")
  })

  it("shows Codex hierarchy with --codex flag", async () => {
    const { stdout } = await runMemory(["--codex"])
    expect(stdout).toContain("Codex CLI")
    expect(stdout).toContain("AGENTS.md")
  })

  it("shows Cursor hierarchy with --cursor flag", async () => {
    const { stdout } = await runMemory(["--cursor"])
    expect(stdout).toContain("Cursor")
    expect(stdout).toContain(".cursorrules")
  })

  it("supports --dir flag to target another directory", async () => {
    const { stdout } = await runMemory(["--claude", "--dir", "/tmp"])
    expect(stdout).toContain("/tmp")
    expect(stdout).toContain("Claude Code")
  })

  it("supports -d shorthand for --dir", async () => {
    const { stdout } = await runMemory(["--claude", "-d", "/tmp"])
    expect(stdout).toContain("/tmp")
  })

  it("errors when no agent detected and no flag given", async () => {
    const { stderr, exitCode } = await runMemory([])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("No agent detected")
  })

  it("explicit agent flag overrides env detection", async () => {
    const { stdout } = await runMemory(["--gemini"], { CLAUDECODE: "1" })
    expect(stdout).toContain("Gemini CLI")
    expect(stdout).not.toContain("Claude Code")
  })
})
