import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("pretooluse-claude-word-limit", () => {
  let tempDir: string
  let claudeMdPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-word-limit-test-"))
    claudeMdPath = join(tempDir, "CLAUDE.md")
  })

  afterEach(() => {
    try {
      unlinkSync(claudeMdPath)
    } catch {
      // File may not exist
    }
  })

  async function runHook(
    command: string
  ): Promise<{ stdout: string; stderr: string; blocked: boolean }> {
    // Create input JSON for the hook
    const input = {
      cwd: tempDir,
      tool_name: "Bash",
      tool_input: { command },
    }

    // Run the hook
    const proc = Bun.spawn(["bun", join(import.meta.dir, "pretooluse-claude-word-limit.ts")], {
      cwd: tempDir,
      stdin: new Response(JSON.stringify(input)).body,
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    // Check if the hook output contains a denial (permissionDecision: "deny")
    const blocked =
      stdout.includes('"permissionDecision":"deny"') ||
      stdout.includes("'permissionDecision': 'deny'")

    return {
      stdout,
      stderr,
      blocked,
    }
  }

  it("allows push when CLAUDE.md <= 5000 words", async () => {
    // Create a CLAUDE.md with 4900 words
    const content = "word ".repeat(4900).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("blocks push when CLAUDE.md > 5000 words", async () => {
    // Create a CLAUDE.md with 5100 words
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.blocked).toBe(true)
    expect(result.stdout).toContain("exceeds 5000-word limit")
  })

  it("shows current word count in error message", async () => {
    // Create a CLAUDE.md with 5050 words
    const content = "word ".repeat(5050).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.stdout).toContain("5050 words")
  })

  it("shows how many words over the limit", async () => {
    // Create a CLAUDE.md with 5025 words (25 over)
    const content = "word ".repeat(5025).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.stdout).toContain("25 over")
  })

  it("suggests reduction amount", async () => {
    // Create a CLAUDE.md with 5010 words (10 over)
    const content = "word ".repeat(5010).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    // Should suggest reducing by at least 11 words
    expect(result.stdout).toContain("at least 11 words")
  })

  it("allows push when CLAUDE.md doesn't exist", async () => {
    // Don't create CLAUDE.md
    const result = await runHook("git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("ignores non-git-push commands", async () => {
    // Create a CLAUDE.md with 5100 words
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)

    // Try to run git add (not git push)
    const result = await runHook("git add .")
    expect(result.blocked).toBe(false) // Should not block git add
  })

  it("ignores non-shell tools", async () => {
    // Create a CLAUDE.md with 5100 words
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)

    // Create input with Edit tool (not Bash)
    const input = {
      cwd: tempDir,
      tool_name: "Edit",
      tool_input: { command: "git push origin main" }, // Even if command field exists
    }

    const proc = Bun.spawn(["bun", join(import.meta.dir, "pretooluse-claude-word-limit.ts")], {
      cwd: tempDir,
      stdin: new Response(JSON.stringify(input)).body,
      stdout: "pipe",
    })

    await proc.exited
    expect(proc.exitCode).toBe(0) // Should not block non-shell tools
  })

  it("allows exactly 5000 words", async () => {
    // Create a CLAUDE.md with exactly 5000 words
    const content = "word ".repeat(5000).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("blocks at 5001 words", async () => {
    // Create a CLAUDE.md with 5001 words
    const content = "word ".repeat(5001).trim()
    writeFileSync(claudeMdPath, content)

    const result = await runHook("git push origin main")
    expect(result.blocked).toBe(true)
  })
})
