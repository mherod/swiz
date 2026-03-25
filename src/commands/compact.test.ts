import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { COMPACT_MEMORY_SKILL_ID } from "../memory-compaction-guidance.ts"
import { compactText } from "./compact.ts"

const SWIZ_ENTRY = join(import.meta.dir, "../../index.ts")

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCompact(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", SWIZ_ENTRY, COMPACT_MEMORY_SKILL_ID, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 }
}

// ─── Unit tests: compactText ──────────────────────────────────────────────────

describe("compactText", () => {
  it("returns unchanged text when within threshold", () => {
    const text = "hello world\nfoo bar\n"
    const { output, removedCount, before, after } = compactText(text, 100)
    expect(output).toBe(text)
    expect(removedCount).toBe(0)
    expect(before).toBe(4)
    expect(after).toBe(4)
  })

  it("removes shrinkable lines to reach threshold", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `This is line number ${i + 1} with some words`
    ).join("\n")
    const { output, removedCount, before, after } = compactText(lines, 20)
    expect(before).toBeGreaterThan(20)
    expect(after).toBeLessThanOrEqual(20)
    expect(removedCount).toBeGreaterThan(0)
    // Output should have fewer lines
    expect(output.split("\n").length).toBeLessThan(lines.split("\n").length)
  })

  it("never removes pinned heading lines", () => {
    const text = [
      "## Important Section",
      "This is narrative prose that can be removed.",
      "More removable prose here.",
      "Even more removable content to exceed threshold.",
    ].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("## Important Section")
  })

  it("never removes DO directive lines", () => {
    const text = [
      "- **DO**: Always use this pattern in your code.",
      "This is narrative prose that can be removed because it is not a directive.",
      "More removable prose here to push over threshold.",
      "Another removable sentence to make the threshold meaningful.",
    ].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("- **DO**: Always use this pattern in your code.")
  })

  it("never removes DON'T directive lines", () => {
    const text = [
      "- **DON'T**: Never skip this important step ever.",
      "This is removable prose content that should be trimmed away.",
      "More removable content here to push over threshold.",
      "Additional padding to exceed the word limit significantly.",
    ].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("- **DON'T**: Never skip this important step ever.")
  })

  it("never removes NEVER directive lines", () => {
    const text = [
      "- **NEVER**: Skip the quality gate before merging code.",
      "Removable prose content used to exceed word threshold here.",
      "More padding content here to push over threshold significantly.",
    ].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("- **NEVER**: Skip the quality gate before merging code.")
  })

  it("never removes lines inside code fences", () => {
    const text = [
      "```typescript",
      "const x = 1",
      "const y = doSomething()",
      "```",
      "This prose line is removable and should be cut first.",
      "More padding to exceed threshold and trigger compaction.",
    ].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("const x = 1")
    expect(output).toContain("const y = doSomething()")
  })

  it("preserves all content when threshold equals total words", () => {
    const text = "hello world\nfoo bar\n"
    const words = text.trim().split(/\s+/).length
    const { output, removedCount } = compactText(text, words)
    expect(output).toBe(text)
    expect(removedCount).toBe(0)
  })

  it("removes longest shrinkable lines first (greedy by word count)", () => {
    // "## Header" = 2 words (pinned), "Short line." = 2 words, long = 14 words; total = 18
    // With threshold=5: deficit=13, long line (14 words) covers it → only long is removed
    const short = "Short line."
    const long = "This is a very long line with many words that should be removed first."
    const text = [short, long, "## Header"].join("\n")
    const { output } = compactText(text, 5)
    expect(output).toContain("Short line.")
    expect(output).toContain("## Header")
    expect(output).not.toContain("This is a very long line")
  })

  it("collapses more than 2 consecutive empty lines", () => {
    const text = "Line one.\n\n\n\n\nLine two.\n"
    const { output } = compactText(text, 1000)
    // 4+ consecutive empties become at most 2
    const emptyRun = output.match(/\n{3,}/)
    expect(emptyRun).toBeNull()
  })

  it("returns output with before and after word counts", () => {
    const text = "word1 word2 word3\nword4 word5\n"
    const { before, after } = compactText(text, 3)
    expect(before).toBe(5)
    expect(after).toBeLessThanOrEqual(3)
  })
})

// ─── CLI integration tests ────────────────────────────────────────────────────

describe("swiz compact-memory CLI", () => {
  it("exits with error when no file argument given", async () => {
    const { exitCode, stderr } = await runCompact([])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Usage:")
  })

  it("exits with error for missing file", async () => {
    const { exitCode, stderr } = await runCompact(["/nonexistent/path/to/memory.md"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("not found")
  })

  it("reports no changes when file is within threshold", async () => {
    const tmpFile = join(tmpdir(), `compact-test-within-${Date.now()}.md`)
    writeFileSync(tmpFile, "## Section\n- **DO**: Something important.\n")

    const { stdout, exitCode } = await runCompact([tmpFile, "--threshold", "100"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("within threshold")
  })

  it("compacts file in place when over threshold", async () => {
    const tmpFile = join(tmpdir(), `compact-test-over-${Date.now()}.md`)
    const content = [
      "## Section",
      "- **DO**: Keep this important directive.",
      ...Array.from(
        { length: 50 },
        (_, i) => `This is verbose prose line ${i + 1} that should be removed.`
      ),
    ].join("\n")
    writeFileSync(tmpFile, content)

    const { stdout, exitCode } = await runCompact([tmpFile, "--threshold", "20"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("File updated")

    const result = await Bun.file(tmpFile).text()
    expect(result).toContain("- **DO**: Keep this important directive.")
    // Should be compacted
    const words = result.trim().split(/\s+/).filter(Boolean).length
    expect(words).toBeLessThanOrEqual(25) // allow some slack for the greedy algorithm
  })

  it("--dry-run does not modify file", async () => {
    const tmpFile = join(tmpdir(), `compact-test-dryrun-${Date.now()}.md`)
    const content = Array.from(
      { length: 30 },
      (_, i) => `Verbose prose line ${i + 1} to exceed threshold.`
    ).join("\n")
    writeFileSync(tmpFile, content)

    const originalContent = content
    const { stdout, exitCode } = await runCompact([tmpFile, "--threshold", "10", "--dry-run"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("dry-run")

    const fileAfter = await Bun.file(tmpFile).text()
    expect(fileAfter).toBe(originalContent)
  })

  it("accepts -t shorthand for --threshold", async () => {
    const tmpFile = join(tmpdir(), `compact-test-t-${Date.now()}.md`)
    writeFileSync(tmpFile, "## Section\n- **DO**: Keep this.\n")

    const { stdout, exitCode } = await runCompact([tmpFile, "-t", "100"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("within threshold")
  })

  it("exits with error for invalid threshold", async () => {
    const tmpFile = join(tmpdir(), `compact-test-bad-threshold-${Date.now()}.md`)
    writeFileSync(tmpFile, "some content\n")

    const { exitCode, stderr } = await runCompact([tmpFile, "--threshold", "abc"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("threshold")
  })
})
