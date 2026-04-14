import { mkdirSync } from "node:fs"
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
  it("returns Claude sources in precedence order", async () => {
    const sources = await getMemorySources(getAgent("claude"), "/tmp/myproject")
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

  it("returns Cursor sources including .cursorrules", async () => {
    const sources = await getMemorySources(getAgent("cursor"), "/tmp/myproject")
    expect(sources.length).toBeGreaterThanOrEqual(2)
    expect(sources[0]?.label).toContain(".cursorrules")
  })

  it("returns Gemini sources with project and global", async () => {
    const sources = await getMemorySources(getAgent("gemini"), "/tmp/myproject")
    expect(sources.length).toBe(3)
    expect(sources[0]?.path).toContain("GEMINI.md")
    expect(sources[2]?.path).toContain(".gemini/GEMINI.md")
  })

  it("returns Codex sources with AGENTS.md and instructions", async () => {
    const sources = await getMemorySources(getAgent("codex"), "/tmp/myproject")
    expect(sources.length).toBe(3)
    expect(sources[0]?.path).toContain("AGENTS.md")
    expect(sources[1]?.path).toContain(".codex/AGENTS.md")
    expect(sources[2]?.path).toContain("instructions.md")
    expect(sources.some((source) => source.path.includes("history.jsonl"))).toBe(false)
  })

  it("includes additional memory files for Claude projects", async () => {
    // Create a temp dir with extra memory files
    const tmpHome = join(tmpdir(), `swiz-mem-test-${Date.now()}`)
    const projectKey = "-tmp-memproj"
    const memDir = join(tmpHome, ".claude", "projects", projectKey, "memory")
    mkdirSync(memDir, { recursive: true })
    await Bun.write(join(memDir, "MEMORY.md"), "# Memory\n")
    await Bun.write(join(memDir, "debugging.md"), "# Debug notes\n")
    await Bun.write(join(memDir, "patterns.md"), "# Patterns\n")

    // Override HOME for agent resolution
    const origHome = process.env.HOME
    process.env.HOME = tmpHome
    try {
      const sources = await getMemorySources(getAgent("claude"), "/tmp/memproj")
      const labels = sources.map((s) => s.label)
      expect(labels).toContain("Project memory (debugging.md)")
      expect(labels).toContain("Project memory (patterns.md)")
    } finally {
      process.env.HOME = origHome
    }
  })

  it("handles Cursor project with .cursor/rules directory", async () => {
    const tmpDir = join(tmpdir(), `swiz-cursor-test-${Date.now()}`)
    const rulesDir = join(tmpDir, ".cursor", "rules")
    mkdirSync(rulesDir, { recursive: true })
    await Bun.write(join(rulesDir, "style.mdc"), "# Style\n")
    await Bun.write(join(rulesDir, "testing.md"), "# Testing\n")

    const sources = await getMemorySources(getAgent("cursor"), tmpDir)
    const labels = sources.map((s) => s.label)
    expect(labels).toContain("Project rule (style.mdc)")
    expect(labels).toContain("Project rule (testing.md)")
  })
})

// ─── CLI integration tests ──────────────────────────────────────────────────

describe("swiz memory CLI", () => {
  it("shows Claude hierarchy when CLAUDECODE=1", async () => {
    const tmpHome = join(tmpdir(), `swiz-memory-claude-${Date.now()}`)
    const claudeDir = join(tmpHome, ".claude")
    mkdirSync(claudeDir, { recursive: true })
    await Bun.write(join(claudeDir, "CLAUDE.md"), "# Global Claude rules\n")

    const { stdout } = await runMemory([], { CLAUDECODE: "1", HOME: tmpHome })
    expect(stdout).toContain("Claude Code")
    expect(stdout).toContain("Rule hierarchy")
    expect(stdout).toContain("Project rules")
    expect(stdout).toContain("Global rules")
  }, 15_000)

  it("shows Gemini hierarchy with --gemini flag", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-gemini-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    mkdirSync(projectDir, { recursive: true })
    await Bun.write(join(projectDir, "GEMINI.md"), "# Project Gemini rules\n")

    const { stdout } = await runMemory(["--gemini", "--dir", projectDir])
    expect(stdout).toContain("Gemini CLI")
    expect(stdout).toContain("GEMINI.md")
  }, 15_000)

  it("shows Codex hierarchy with --codex flag", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-codex-${Date.now()}`)
    const homeDir = join(tmpRoot, "home")
    const codexDir = join(homeDir, ".codex")
    mkdirSync(codexDir, { recursive: true })
    const globalRulesPath = join(codexDir, "AGENTS.md")
    await Bun.write(globalRulesPath, "# Codex rules\n")

    const { stdout } = await runMemory(["--codex"], { HOME: homeDir })
    expect(stdout).toContain("Codex CLI")
    expect(stdout).toContain(globalRulesPath)
  })

  it("prints full included file contents with --view", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-view-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const homeDir = join(tmpRoot, "home")
    const codexDir = join(homeDir, ".codex")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })

    const projectRulesPath = join(projectDir, "AGENTS.md")
    const globalRulesPath = join(codexDir, "AGENTS.md")
    const globalInstructionsPath = join(codexDir, "instructions.md")

    await Bun.write(projectRulesPath, "PROJECT_RULES_LINE\n")
    await Bun.write(globalRulesPath, "GLOBAL_RULES_LINE\n")
    await Bun.write(globalInstructionsPath, "GLOBAL_INSTRUCTIONS_LINE\n")

    const { stdout, exitCode } = await runMemory(["--codex", "--dir", projectDir, "--view"], {
      HOME: homeDir,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain("PROJECT_RULES_LINE")
    expect(stdout).toContain("GLOBAL_RULES_LINE")
    expect(stdout).toContain("GLOBAL_INSTRUCTIONS_LINE")
  })

  it("shows Cursor hierarchy with --cursor flag and .cursor/rules/*.mdc files", async () => {
    // Create a controlled fixture with the canonical Cursor rules structure:
    //   <project>/.cursorrules         — top-level entry file
    //   <project>/.cursor/rules/*.mdc  — topic-based rule files
    const tmpRoot = join(tmpdir(), `swiz-memory-cursor-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const rulesDir = join(projectDir, ".cursor", "rules")
    mkdirSync(rulesDir, { recursive: true })
    await Bun.write(join(projectDir, ".cursorrules"), "# Root cursor rules\n")
    await Bun.write(join(rulesDir, "coding-standards.mdc"), "# Coding standards\n")
    await Bun.write(join(rulesDir, "architecture.mdc"), "# Architecture\n")

    const { stdout } = await runMemory(["--cursor", "--dir", projectDir])
    expect(stdout).toContain("Cursor")
    expect(stdout).toContain("Rule hierarchy")
    expect(stdout).toContain(".cursorrules")
    expect(stdout).toContain("coding-standards.mdc")
    expect(stdout).toContain("architecture.mdc")
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

  it("shows all agent hierarchies when no agent is detected", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-all-agents-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const homeDir = join(tmpRoot, "home")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(homeDir, ".claude"), { recursive: true })
    mkdirSync(join(homeDir, ".gemini"), { recursive: true })
    mkdirSync(join(homeDir, ".codex"), { recursive: true })

    await Bun.write(join(projectDir, "CLAUDE.md"), "# Claude\n")
    await Bun.write(join(projectDir, ".cursorrules"), "# Cursor\n")
    await Bun.write(join(projectDir, "GEMINI.md"), "# Gemini\n")
    await Bun.write(join(projectDir, "AGENTS.md"), "# Codex\n")

    const { stdout, exitCode } = await runMemory(["--dir", projectDir], { HOME: homeDir })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Agents: ")
    expect(stdout).toContain("Claude Code")
    expect(stdout).toContain("Cursor")
    expect(stdout).toContain("Gemini CLI")
    expect(stdout).not.toContain("No memory files found")
  }, 15_000)

  it("supports --all and overrides detected agent context", async () => {
    const { stdout, exitCode } = await runMemory(["--all"], { CLAUDECODE: "1" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Agents: ")
    expect(stdout).toContain("Claude Code")
    expect(stdout).toContain("Thresholds:")
    expect(stdout).not.toContain("No memory files found")
  })

  it("shows only existing agent files in --all mode", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-all-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const homeDir = join(tmpRoot, "home")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    await Bun.write(join(projectDir, "AGENTS.md"), "# Project Codex rules\n")

    const { stdout, exitCode } = await runMemory(["--all", "--dir", projectDir], { HOME: homeDir })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Codex CLI")
    expect(stdout).toContain(join(projectDir, "AGENTS.md"))
    expect(stdout).not.toContain("Claude Code")
    expect(stdout).not.toContain("Cursor")
    expect(stdout).not.toContain("Gemini CLI")
    expect(stdout).not.toContain("No memory files found")
    expect(stdout).not.toContain("Rule hierarchy")
    expect(stdout).toContain("Thresholds:")
  })

  it("treats empty memory files as missing", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-empty-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const homeDir = join(tmpRoot, "home")
    const codexDir = join(homeDir, ".codex")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })

    const projectRulesPath = join(projectDir, "AGENTS.md")
    const globalRulesPath = join(codexDir, "AGENTS.md")
    const globalInstructionsPath = join(codexDir, "instructions.md")

    await Bun.write(projectRulesPath, "")
    await Bun.write(globalRulesPath, "# Global Codex rules\n")
    await Bun.write(globalInstructionsPath, "")

    const { stdout, exitCode } = await runMemory(["--codex", "--dir", projectDir], {
      HOME: homeDir,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Rule hierarchy")
    expect(stdout).toContain("(1 files present)")
    expect(stdout).toContain(globalRulesPath)
    expect(stdout).not.toContain(projectRulesPath)
    expect(stdout).not.toContain(globalInstructionsPath)
    expect(stdout).not.toContain("0B")
  })

  it("prints only included file contents in --view mode", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-view-empty-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    const homeDir = join(tmpRoot, "home")
    const codexDir = join(homeDir, ".codex")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })

    const projectRulesPath = join(projectDir, "AGENTS.md")
    const globalRulesPath = join(codexDir, "AGENTS.md")
    const globalInstructionsPath = join(codexDir, "instructions.md")

    await Bun.write(projectRulesPath, "")
    await Bun.write(globalRulesPath, "ONLY_INCLUDED_CONTENT\n")
    await Bun.write(globalInstructionsPath, "")

    const { stdout, exitCode } = await runMemory(["--codex", "--dir", projectDir, "--view"], {
      HOME: homeDir,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain("ONLY_INCLUDED_CONTENT")
    expect(stdout).not.toContain(projectRulesPath)
    expect(stdout).not.toContain(globalInstructionsPath)
  })

  it("errors when --all is combined with an explicit agent flag", async () => {
    const { stderr, exitCode } = await runMemory(["--all", "--gemini"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("cannot be combined")
  })

  it("explicit agent flag overrides env detection", async () => {
    const tmpRoot = join(tmpdir(), `swiz-memory-override-${Date.now()}`)
    const projectDir = join(tmpRoot, "project")
    mkdirSync(projectDir, { recursive: true })
    await Bun.write(join(projectDir, "GEMINI.md"), "# Project Gemini rules\n")

    const { stdout } = await runMemory(["--gemini", "--dir", projectDir], { CLAUDECODE: "1" })
    expect(stdout).toContain("Gemini CLI")
    expect(stdout).not.toContain("Claude Code")
  })
})
