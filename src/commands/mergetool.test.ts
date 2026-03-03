import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  hasConflictMarkers,
  parseMergetoolArgs,
  stripCodeFences,
  validatePaths,
} from "./mergetool.ts"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "swiz-mergetool-test-"))
}

function writeFiles(dir: string, files: Record<string, string>): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    writeFileSync(p, content)
    paths[name] = p
  }
  return paths
}

// ─── parseMergetoolArgs ──────────────────────────────────────────────────────

describe("parseMergetoolArgs", () => {
  it("parses four positional args", () => {
    const result = parseMergetoolArgs(["/a/base", "/a/local", "/a/remote", "/a/merged"])
    expect(result.base).toBe("/a/base")
    expect(result.local).toBe("/a/local")
    expect(result.remote).toBe("/a/remote")
    expect(result.merged).toBe("/a/merged")
  })

  it("throws when fewer than four args", () => {
    expect(() => parseMergetoolArgs([])).toThrow("four file paths")
    expect(() => parseMergetoolArgs(["/a"])).toThrow("four file paths")
    expect(() => parseMergetoolArgs(["/a", "/b"])).toThrow("four file paths")
    expect(() => parseMergetoolArgs(["/a", "/b", "/c"])).toThrow("four file paths")
  })

  it("ignores flags and uses only positionals", () => {
    const result = parseMergetoolArgs(["--verbose", "/a", "/b", "/c", "/d"])
    expect(result.base).toBe("/a")
    expect(result.local).toBe("/b")
    expect(result.remote).toBe("/c")
    expect(result.merged).toBe("/d")
  })

  it("handles extra positionals beyond four", () => {
    const result = parseMergetoolArgs(["/a", "/b", "/c", "/d", "/e"])
    expect(result.base).toBe("/a")
    expect(result.merged).toBe("/d")
  })
})

// ─── validatePaths ───────────────────────────────────────────────────────────

describe("validatePaths", () => {
  it("succeeds when all files exist", () => {
    const dir = tmpDir()
    const paths = writeFiles(dir, {
      base: "base",
      local: "local",
      remote: "remote",
      merged: "merged",
    })
    expect(() =>
      validatePaths({
        base: paths["base"]!,
        local: paths["local"]!,
        remote: paths["remote"]!,
        merged: paths["merged"]!,
      })
    ).not.toThrow()
  })

  it("throws when BASE does not exist", () => {
    const dir = tmpDir()
    const paths = writeFiles(dir, { local: "l", remote: "r", merged: "m" })
    expect(() =>
      validatePaths({
        base: join(dir, "nonexistent"),
        local: paths["local"]!,
        remote: paths["remote"]!,
        merged: paths["merged"]!,
      })
    ).toThrow("BASE file does not exist")
  })

  it("throws when LOCAL does not exist", () => {
    const dir = tmpDir()
    const paths = writeFiles(dir, { base: "b", remote: "r", merged: "m" })
    expect(() =>
      validatePaths({
        base: paths["base"]!,
        local: join(dir, "nonexistent"),
        remote: paths["remote"]!,
        merged: paths["merged"]!,
      })
    ).toThrow("LOCAL file does not exist")
  })

  it("throws when REMOTE does not exist", () => {
    const dir = tmpDir()
    const paths = writeFiles(dir, { base: "b", local: "l", merged: "m" })
    expect(() =>
      validatePaths({
        base: paths["base"]!,
        local: paths["local"]!,
        remote: join(dir, "nonexistent"),
        merged: paths["merged"]!,
      })
    ).toThrow("REMOTE file does not exist")
  })

  it("throws when MERGED does not exist", () => {
    const dir = tmpDir()
    const paths = writeFiles(dir, { base: "b", local: "l", remote: "r" })
    expect(() =>
      validatePaths({
        base: paths["base"]!,
        local: paths["local"]!,
        remote: paths["remote"]!,
        merged: join(dir, "nonexistent"),
      })
    ).toThrow("MERGED file does not exist")
  })
})

// ─── hasConflictMarkers ──────────────────────────────────────────────────────

describe("hasConflictMarkers", () => {
  it("detects <<<<<<< marker", () => {
    expect(hasConflictMarkers("<<<<<<< HEAD\nsome code\n=======\nother\n>>>>>>> branch")).toBe(true)
  })

  it("detects ======= marker on its own line", () => {
    expect(hasConflictMarkers("before\n=======\nafter")).toBe(true)
  })

  it("detects >>>>>>> marker", () => {
    expect(hasConflictMarkers(">>>>>>> feature/branch")).toBe(true)
  })

  it("returns false for clean content", () => {
    expect(hasConflictMarkers("const x = 1\nconst y = 2")).toBe(false)
  })

  it("returns false for partial markers (not full 7 chars)", () => {
    expect(hasConflictMarkers("<<<<<< not enough")).toBe(false)
    expect(hasConflictMarkers(">>>>>> not enough")).toBe(false)
  })

  it("returns false for markers inside strings", () => {
    // Markers must be at start of line — embedded ones don't count
    expect(hasConflictMarkers('const x = "<<<<<<< HEAD"')).toBe(false)
  })

  it("returns false for empty content", () => {
    expect(hasConflictMarkers("")).toBe(false)
  })
})

// ─── stripCodeFences ─────────────────────────────────────────────────────────

describe("stripCodeFences", () => {
  it("strips bare code fences", () => {
    expect(stripCodeFences("```\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("strips language-tagged code fences", () => {
    expect(stripCodeFences("```typescript\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("returns content unchanged when no fences", () => {
    expect(stripCodeFences("const x = 1")).toBe("const x = 1")
  })

  it("handles multiline content within fences", () => {
    const input = "```ts\nline1\nline2\nline3\n```"
    expect(stripCodeFences(input)).toBe("line1\nline2\nline3")
  })

  it("trims surrounding whitespace", () => {
    expect(stripCodeFences("  const x = 1  ")).toBe("const x = 1")
  })

  it("handles content that contains backticks but is not fenced", () => {
    expect(stripCodeFences("const x = `template`")).toBe("const x = `template`")
  })
})

// ─── buildPrompt ─────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("includes all four file contents", () => {
    const prompt = buildPrompt("base", "local", "remote", "merged", "repo context")
    expect(prompt).toContain("base")
    expect(prompt).toContain("local")
    expect(prompt).toContain("remote")
    expect(prompt).toContain("merged")
  })

  it("includes repo context", () => {
    const prompt = buildPrompt("b", "l", "r", "m", "File: src/foo.ts")
    expect(prompt).toContain("File: src/foo.ts")
  })

  it("includes resolution strategy guidance", () => {
    const prompt = buildPrompt("b", "l", "r", "m", "ctx")
    expect(prompt).toContain("Keep ours")
    expect(prompt).toContain("Keep theirs")
    expect(prompt).toContain("Keep both")
    expect(prompt).toContain("Create hybrid")
  })

  it("instructs no conflict markers in output", () => {
    const prompt = buildPrompt("b", "l", "r", "m", "ctx")
    expect(prompt).toContain("Do NOT include any conflict markers")
  })

  it("instructs no code fences in output", () => {
    const prompt = buildPrompt("b", "l", "r", "m", "ctx")
    expect(prompt).toContain("Do NOT wrap the output in code fences")
  })

  it("instructs to check for duplicate imports", () => {
    const prompt = buildPrompt("b", "l", "r", "m", "ctx")
    expect(prompt).toContain("duplicate imports")
  })
})
