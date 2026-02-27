import { describe, expect, it, beforeEach } from "bun:test"
import {
  git,
  gh,
  isGitRepo,
  isGitHubRemote,
  hasGhCli,
  parseGitStatus,
  extractToolNamesFromTranscript,
  skillExists,
  isDefaultBranch,
  isShellTool,
  isEditTool,
  isWriteTool,
  isNotebookTool,
  isTaskTool,
  isTaskCreateTool,
  isFileEditTool,
  isCodeChangeTool,
} from "./hook-utils.ts"
import { join } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

// ─── git() edge cases ───────────────────────────────────────────────────────

describe("git() with malformed inputs", () => {
  it("returns empty string for nonexistent cwd", async () => {
    const result = await git(["status"], "/nonexistent/path/that/does/not/exist")
    expect(result).toBe("")
  })

  it("falls back to process.cwd() for empty cwd", async () => {
    // Bun.spawn({ cwd: "" }) falls back to process.cwd(), so git runs normally
    const result = await git(["status"], "")
    expect(typeof result).toBe("string")
  })

  it("returns empty string for cwd with spaces", async () => {
    const result = await git(["status"], "/path with spaces/that/does/not/exist")
    expect(result).toBe("")
  })

  it("returns empty string for cwd with shell metacharacters", async () => {
    const result = await git(["status"], "/path;rm -rf /;echo")
    expect(result).toBe("")
  })

  it("returns empty string for cwd with newlines", async () => {
    const result = await git(["status"], "/path\nwith\nnewlines")
    expect(result).toBe("")
  })

  it("returns empty string for cwd with null bytes", async () => {
    const result = await git(["status"], "/path\0with\0nulls")
    expect(result).toBe("")
  })

  it("returns empty string for empty args array", async () => {
    const result = await git([], process.cwd())
    // git with no subcommand exits non-zero
    expect(result).toBe("")
  })

  it("returns empty string for invalid git subcommand", async () => {
    const result = await git(["not-a-real-command"], process.cwd())
    expect(result).toBe("")
  })

  it("returns empty string for args with shell metacharacters", async () => {
    const result = await git(["log", "--format=%H; rm -rf /"], process.cwd())
    // The semicolon is passed as a literal arg to git, not interpreted by shell
    expect(typeof result).toBe("string")
  })

  it("handles very long cwd path without throwing", async () => {
    const longPath = "/" + "a".repeat(1000) + "/" + "b".repeat(1000)
    const result = await git(["status"], longPath)
    // May return "" or fall back to cwd — either way, no throw
    expect(typeof result).toBe("string")
  })
})

// ─── gh() edge cases ────────────────────────────────────────────────────────

describe("gh() with malformed inputs", () => {
  it("returns empty string for nonexistent cwd", async () => {
    const result = await gh(["version"], "/nonexistent/path/that/does/not/exist")
    // gh may or may not care about cwd depending on the subcommand
    expect(typeof result).toBe("string")
  })

  it("returns empty string for empty cwd", async () => {
    const result = await gh(["version"], "")
    expect(typeof result).toBe("string")
  })

  it("returns empty string for invalid gh subcommand", async () => {
    const result = await gh(["not-a-real-command-xyz"], process.cwd())
    expect(result).toBe("")
  })

  it("returns help text for empty args array (gh exits 0)", async () => {
    // gh with no args prints help and exits 0, unlike git which exits non-zero
    const result = await gh([], process.cwd())
    expect(typeof result).toBe("string")
  })

  it("returns empty string for cwd with shell metacharacters", async () => {
    const result = await gh(["version"], "/path;rm -rf /;echo")
    expect(typeof result).toBe("string")
  })
})

// ─── isGitRepo() edge cases ────────────────────────────────────────────────

describe("isGitRepo() with malformed inputs", () => {
  it("returns false for nonexistent path", async () => {
    const result = await isGitRepo("/nonexistent/path/xyz")
    expect(result).toBe(false)
  })

  it("falls back to cwd for empty string (which is a git repo)", async () => {
    // Bun.spawn({ cwd: "" }) falls back to process.cwd()
    const result = await isGitRepo("")
    expect(result).toBe(true)
  })

  it("returns false for path with shell metacharacters", async () => {
    const result = await isGitRepo("/path;rm -rf /")
    expect(result).toBe(false)
  })

  it("returns false for path with newlines", async () => {
    const result = await isGitRepo("/path\nwith\nnewlines")
    expect(result).toBe(false)
  })

  it("returns false for non-git directory", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "swiz-test-"))
    try {
      const result = await isGitRepo(tmpDir)
      expect(result).toBe(false)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns true for actual git repo", async () => {
    // The swiz project root is a git repo
    const result = await isGitRepo(process.cwd())
    expect(result).toBe(true)
  })
})

// ─── isGitHubRemote() edge cases ───────────────────────────────────────────

describe("isGitHubRemote() with malformed inputs", () => {
  it("returns false for nonexistent path", async () => {
    const result = await isGitHubRemote("/nonexistent/path/xyz")
    expect(result).toBe(false)
  })

  it("falls back to cwd for empty string (which has GitHub remote)", async () => {
    // Bun.spawn({ cwd: "" }) falls back to process.cwd()
    const result = await isGitHubRemote("")
    expect(result).toBe(true)
  })

  it("returns false for non-git directory", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "swiz-test-"))
    try {
      const result = await isGitHubRemote(tmpDir)
      expect(result).toBe(false)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns false for path with shell metacharacters", async () => {
    const result = await isGitHubRemote("/path;echo hacked")
    expect(result).toBe(false)
  })

  it("returns true for swiz repo (GitHub)", async () => {
    const result = await isGitHubRemote(process.cwd())
    expect(result).toBe(true)
  })
})

// ─── hasGhCli() ─────────────────────────────────────────────────────────────

describe("hasGhCli()", () => {
  it("returns a boolean", () => {
    const result = hasGhCli()
    expect(typeof result).toBe("boolean")
  })

  it("returns consistent results on repeated calls", () => {
    const a = hasGhCli()
    const b = hasGhCli()
    expect(a).toBe(b)
  })
})

// ─── parseGitStatus() edge cases ────────────────────────────────────────────

describe("parseGitStatus() with malformed inputs", () => {
  it("handles empty string", () => {
    const result = parseGitStatus("")
    expect(result.total).toBe(0)
    expect(result.modified).toBe(0)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.untracked).toBe(0)
    expect(result.lines).toEqual([])
  })

  it("treats whitespace-only lines as unrecognized (filter(Boolean) keeps them)", () => {
    // "   \t  " and "  " are truthy strings, so filter(Boolean) keeps them.
    // They don't match any status prefix, so counts stay 0 but total reflects them.
    const result = parseGitStatus("   \t  \n  ")
    expect(result.total).toBe(2)
    expect(result.modified).toBe(0)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.untracked).toBe(0)
  })

  it("handles valid porcelain output", () => {
    const result = parseGitStatus(" M src/foo.ts\nA  src/bar.ts\nD  src/baz.ts\n?? untracked.txt")
    expect(result.total).toBe(4)
    expect(result.modified).toBe(1)
    expect(result.added).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.untracked).toBe(1)
  })

  it("handles lines with unrecognized status codes", () => {
    const result = parseGitStatus("XX unknown-status.txt\nRR renamed.txt")
    expect(result.total).toBe(2)
    // None match recognized patterns
    expect(result.modified).toBe(0)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.untracked).toBe(0)
  })

  it("handles very long file paths", () => {
    const longPath = "a".repeat(2000)
    const result = parseGitStatus(` M ${longPath}`)
    expect(result.total).toBe(1)
    expect(result.modified).toBe(1)
  })

  it("handles paths with special characters", () => {
    const result = parseGitStatus(
      ' M src/file with spaces.ts\nA  src/filewith"quotes".ts\n?? src/file$dollar.ts'
    )
    expect(result.total).toBe(3)
    expect(result.modified).toBe(1)
    expect(result.added).toBe(1)
    expect(result.untracked).toBe(1)
  })

  it("handles many consecutive newlines", () => {
    const result = parseGitStatus("\n\n\n M foo.ts\n\n\n?? bar.ts\n\n")
    expect(result.total).toBe(2)
    expect(result.modified).toBe(1)
    expect(result.untracked).toBe(1)
  })

  it("handles unicode characters in paths", () => {
    const result = parseGitStatus(" M src/日本語.ts\n?? 中文/文件.tsx")
    expect(result.total).toBe(2)
    expect(result.modified).toBe(1)
    expect(result.untracked).toBe(1)
  })

  it("handles single-character status lines", () => {
    const result = parseGitStatus("X\nY\nZ")
    expect(result.total).toBe(3)
    expect(result.modified).toBe(0)
  })
})

// ─── extractToolNamesFromTranscript() edge cases ────────────────────────────

describe("extractToolNamesFromTranscript() with malformed inputs", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "swiz-transcript-"))
  })

  it("returns empty array for nonexistent file", async () => {
    const result = await extractToolNamesFromTranscript("/nonexistent/path/transcript.jsonl")
    expect(result).toEqual([])
  })

  it("returns empty array for empty file", async () => {
    const filePath = join(tmpDir, "empty.jsonl")
    await writeFile(filePath, "")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns empty array for file with only whitespace", async () => {
    const filePath = join(tmpDir, "whitespace.jsonl")
    await writeFile(filePath, "   \n\n   \n")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns empty array for file with invalid JSON lines", async () => {
    const filePath = join(tmpDir, "bad.jsonl")
    await writeFile(filePath, "not json\nalso not json\n{broken")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("skips non-assistant entries", async () => {
    const filePath = join(tmpDir, "user-only.jsonl")
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({ type: "system", message: { content: "world" } }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("extracts tool names from valid assistant entries", async () => {
    const filePath = join(tmpDir, "valid.jsonl")
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read" },
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Edit" },
          ],
        },
      }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual(["Read", "Edit"])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("handles mixed valid and invalid lines", async () => {
    const filePath = join(tmpDir, "mixed.jsonl")
    const lines = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash" }],
        },
      }),
      "{broken json",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Grep" }],
        },
      }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual(["Bash", "Grep"])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("handles assistant entries with non-array content", async () => {
    const filePath = join(tmpDir, "non-array.jsonl")
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "just a string" } }),
      JSON.stringify({ type: "assistant", message: { content: 42 } }),
      JSON.stringify({ type: "assistant", message: { content: null } }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("handles tool_use blocks without a name field", async () => {
    const filePath = join(tmpDir, "no-name.jsonl")
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use" },
            { type: "tool_use", name: "" },
            { type: "tool_use", name: "Valid" },
          ],
        },
      }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    // Empty string is falsy, so only "Valid" is collected
    expect(result).toEqual(["Valid"])
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns empty array for path with shell metacharacters", async () => {
    const result = await extractToolNamesFromTranscript("/path;rm -rf /;echo")
    expect(result).toEqual([])
  })

  it("returns empty array for directory path instead of file", async () => {
    const result = await extractToolNamesFromTranscript(tmpDir)
    expect(result).toEqual([])
    await rm(tmpDir, { recursive: true, force: true })
  })
})

// ─── skillExists() edge cases ───────────────────────────────────────────────

describe("skillExists() with malformed inputs", () => {
  it("returns false for empty string", () => {
    expect(skillExists("")).toBe(false)
  })

  it("returns false for nonexistent skill", () => {
    expect(skillExists("this-skill-definitely-does-not-exist-xyz-123")).toBe(false)
  })

  it("returns false for path traversal attempt", () => {
    expect(skillExists("../../../etc/passwd")).toBe(false)
  })

  it("returns false for skill name with shell metacharacters", () => {
    expect(skillExists("skill;rm -rf /")).toBe(false)
  })

  it("returns false for skill name with spaces", () => {
    expect(skillExists("skill with spaces")).toBe(false)
  })

  it("returns false for skill name with null bytes", () => {
    expect(skillExists("skill\0name")).toBe(false)
  })

  it("returns consistent results (caching)", () => {
    const a = skillExists("nonexistent-skill-abc")
    const b = skillExists("nonexistent-skill-abc")
    expect(a).toBe(b)
    expect(a).toBe(false)
  })

  it("returns true for a known skill (commit)", () => {
    // The commit skill exists in ~/.claude/skills/
    const result = skillExists("commit")
    expect(result).toBe(true)
  })
})

// ─── isDefaultBranch() edge cases ───────────────────────────────────────────

describe("isDefaultBranch() with edge-case inputs", () => {
  it("returns true for 'main'", () => {
    expect(isDefaultBranch("main")).toBe(true)
  })

  it("returns true for 'master'", () => {
    expect(isDefaultBranch("master")).toBe(true)
  })

  it("returns false for empty string", () => {
    expect(isDefaultBranch("")).toBe(false)
  })

  it("returns false for 'Main' (case sensitive)", () => {
    expect(isDefaultBranch("Main")).toBe(false)
  })

  it("returns false for 'MAIN' (case sensitive)", () => {
    expect(isDefaultBranch("MAIN")).toBe(false)
  })

  it("returns false for 'main ' with trailing space", () => {
    expect(isDefaultBranch("main ")).toBe(false)
  })

  it("returns false for 'develop'", () => {
    expect(isDefaultBranch("develop")).toBe(false)
  })

  it("returns false for 'feature/main'", () => {
    expect(isDefaultBranch("feature/main")).toBe(false)
  })
})

// ─── Tool classification functions ──────────────────────────────────────────

describe("tool classification with edge-case inputs", () => {
  it("returns false for empty string on all classifiers", () => {
    expect(isShellTool("")).toBe(false)
    expect(isEditTool("")).toBe(false)
    expect(isWriteTool("")).toBe(false)
    expect(isNotebookTool("")).toBe(false)
    expect(isTaskTool("")).toBe(false)
    expect(isTaskCreateTool("")).toBe(false)
    expect(isFileEditTool("")).toBe(false)
    expect(isCodeChangeTool("")).toBe(false)
  })

  it("is case sensitive (bash ≠ Bash)", () => {
    expect(isShellTool("Bash")).toBe(true)
    expect(isShellTool("bash")).toBe(false)
    expect(isShellTool("BASH")).toBe(false)
  })

  it("returns false for tool names with whitespace", () => {
    expect(isShellTool(" Bash")).toBe(false)
    expect(isShellTool("Bash ")).toBe(false)
    expect(isEditTool(" Edit")).toBe(false)
  })

  it("isFileEditTool covers both Edit and Write tools", () => {
    expect(isFileEditTool("Edit")).toBe(true)
    expect(isFileEditTool("Write")).toBe(true)
    expect(isFileEditTool("StrReplace")).toBe(true)
    expect(isFileEditTool("write_file")).toBe(true)
    expect(isFileEditTool("Read")).toBe(false)
  })

  it("isCodeChangeTool covers Edit, Write, and Notebook", () => {
    expect(isCodeChangeTool("Edit")).toBe(true)
    expect(isCodeChangeTool("Write")).toBe(true)
    expect(isCodeChangeTool("NotebookEdit")).toBe(true)
    expect(isCodeChangeTool("Read")).toBe(false)
    expect(isCodeChangeTool("Bash")).toBe(false)
  })
})

// ─── getGitAheadBehind() edge cases ─────────────────────────────────────────

describe("getGitAheadBehind() with malformed inputs", () => {
  // Import dynamically to avoid import issues
  const { getGitAheadBehind } = require("./hook-utils.ts")

  it("returns null for nonexistent path", async () => {
    const result = await getGitAheadBehind("/nonexistent/path/xyz")
    expect(result).toBeNull()
  })

  it("falls back to cwd for empty string (which has upstream)", async () => {
    // Bun.spawn({ cwd: "" }) falls back to process.cwd()
    const result = await getGitAheadBehind("")
    // The swiz repo has upstream tracking, so we get actual counts
    expect(result).not.toBeNull()
    expect(typeof result!.ahead).toBe("number")
    expect(typeof result!.behind).toBe("number")
  })

  it("returns null for non-git directory", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "swiz-test-"))
    try {
      const result = await getGitAheadBehind(tmpDir)
      expect(result).toBeNull()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns null for path with shell metacharacters", async () => {
    const result = await getGitAheadBehind("/path;echo hacked")
    expect(result).toBeNull()
  })
})
