import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Create a unique temp dir with a CLAUDE.md path (concurrent-safe). */
function setup(): { tempDir: string; claudeMdPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-word-limit-test-"))
  return { tempDir, claudeMdPath: join(tempDir, "CLAUDE.md") }
}

async function runHook(
  tempDir: string,
  command: string
): Promise<{ stdout: string; stderr: string; blocked: boolean }> {
  const input = {
    cwd: tempDir,
    tool_name: "Bash",
    tool_input: { command },
  }

  const proc = Bun.spawn(["bun", join(import.meta.dir, "pretooluse-claude-word-limit.ts")], {
    cwd: tempDir,
    stdin: new Response(JSON.stringify(input)).body,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  const blocked =
    stdout.includes('"permissionDecision":"deny"') ||
    stdout.includes("'permissionDecision': 'deny'")

  return { stdout, stderr, blocked }
}

describe("pretooluse-claude-word-limit", () => {
  it("allows push when CLAUDE.md <= 5000 words", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(4900).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("blocks push when CLAUDE.md > 5000 words", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.blocked).toBe(true)
    expect(result.stdout).toContain("exceeds 5000-word limit")
  })

  it("shows current word count in error message", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5050).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.stdout).toContain("5050 words")
  })

  it("shows how many words over the limit", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5025).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.stdout).toContain("25 over")
  })

  it("suggests reduction amount", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5010).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.stdout).toContain("at least 11 words")
  })

  it("allows push when CLAUDE.md doesn't exist", async () => {
    const { tempDir } = setup()
    const result = await runHook(tempDir, "git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("ignores non-git-push commands", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git add .")
    expect(result.blocked).toBe(false)
  })

  it("ignores non-shell tools", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5100).trim()
    writeFileSync(claudeMdPath, content)

    const input = {
      cwd: tempDir,
      tool_name: "Edit",
      tool_input: { command: "git push origin main" },
    }

    const proc = Bun.spawn(["bun", join(import.meta.dir, "pretooluse-claude-word-limit.ts")], {
      cwd: tempDir,
      stdin: new Response(JSON.stringify(input)).body,
      stdout: "pipe",
    })

    await proc.exited
    expect(proc.exitCode).toBe(0)
  })

  it("allows exactly 5000 words", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5000).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.blocked).toBe(false)
  })

  it("blocks at 5001 words", async () => {
    const { tempDir, claudeMdPath } = setup()
    const content = "word ".repeat(5001).trim()
    writeFileSync(claudeMdPath, content)
    const result = await runHook(tempDir, "git push origin main")
    expect(result.blocked).toBe(true)
  })
})
