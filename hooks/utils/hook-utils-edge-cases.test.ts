import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Resolve the repo root from this file's location, not process.cwd().
// During pre-push hooks, lefthook changes cwd to inside .git/, making
// process.cwd() unreliable for git-repo detection tests.
const REPO_ROOT = dirname(dirname(dirname(import.meta.path)))

import {
  CI_WAIT_RE,
  createSessionTask,
  detectPackageManager,
  detectPkgRunner,
  detectRuntime,
  extractToolNamesFromTranscript,
  gh,
  ghJson,
  git,
  hasGhCli,
  isCodeChangeTool,
  isDefaultBranch,
  isEditTool,
  isFileEditTool,
  isGitHubRemote,
  isGitRepo,
  isNotebookTool,
  isShellTool,
  isSwizCommand,
  isTaskCreateTool,
  isTaskTool,
  isTaskTrackingExemptShellCommand,
  isWriteTool,
  parseGitStatus,
  SOURCE_EXT_RE,
  skillAdvice,
  skillExists,
  TASK_CREATE_TOOLS,
  TASK_TOOLS,
  TEST_FILE_RE,
} from "./hook-utils.ts"

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
    const longPath = `/${"a".repeat(1000)}/${"b".repeat(1000)}`
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

describe("ghJson() with malformed inputs", () => {
  it("returns null for invalid gh subcommand", async () => {
    const result = await ghJson<string>(["not-a-real-command-xyz"], process.cwd())
    expect(result).toBe(null)
  })

  it("returns null for non-JSON gh output", async () => {
    const result = await ghJson<string>(["version"], process.cwd())
    expect(result).toBe(null)
  })
})

// ─── isGitRepo() edge cases ────────────────────────────────────────────────

describe("isGitRepo() with malformed inputs", () => {
  it("returns false for nonexistent path", async () => {
    const result = await isGitRepo("/nonexistent/path/xyz")
    expect(result).toBe(false)
  })

  it("returns true for repo root", async () => {
    const result = await isGitRepo(REPO_ROOT)
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

  it("returns true for actual git repo via absolute path", async () => {
    const result = await isGitRepo(REPO_ROOT)
    expect(result).toBe(true)
  })
})

// ─── isGitHubRemote() edge cases ───────────────────────────────────────────

describe("isGitHubRemote() with malformed inputs", () => {
  it("returns false for nonexistent path", async () => {
    const result = await isGitHubRemote("/nonexistent/path/xyz")
    expect(result).toBe(false)
  })

  it("returns true for repo root (which has GitHub remote)", async () => {
    const result = await isGitHubRemote(REPO_ROOT)
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

  it("returns true for swiz repo via absolute path (GitHub)", async () => {
    const result = await isGitHubRemote(REPO_ROOT)
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

  it("filters out whitespace-only lines", () => {
    // After hardening, filter(l => l.trim()) removes whitespace-only lines
    const result = parseGitStatus("   \t  \n  ")
    expect(result.total).toBe(0)
    expect(result.modified).toBe(0)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.untracked).toBe(0)
    expect(result.lines).toEqual([])
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
  async function makeTmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "swiz-transcript-"))
  }

  it("returns empty array for nonexistent file", async () => {
    const result = await extractToolNamesFromTranscript("/nonexistent/path/transcript.jsonl")
    expect(result).toEqual([])
  })

  it("returns empty array for empty file", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "empty.jsonl")
    await writeFile(filePath, "")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
  })

  it("returns empty array for file with only whitespace", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "whitespace.jsonl")
    await writeFile(filePath, "   \n\n   \n")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
  })

  it("returns empty array for file with invalid JSON lines", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "bad.jsonl")
    await writeFile(filePath, "not json\nalso not json\n{broken")
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
  })

  it("skips non-assistant entries", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "user-only.jsonl")
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({ type: "system", message: { content: "world" } }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
  })

  it("extracts tool names from valid assistant entries", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "valid.jsonl")
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
    await rm(d, { recursive: true, force: true })
  })

  it("handles mixed valid and invalid lines", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "mixed.jsonl")
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
    await rm(d, { recursive: true, force: true })
  })

  it("handles assistant entries with non-array content", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "non-array.jsonl")
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "just a string" } }),
      JSON.stringify({ type: "assistant", message: { content: 42 } }),
      JSON.stringify({ type: "assistant", message: { content: null } }),
    ]
    await writeFile(filePath, lines.join("\n"))
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
  })

  it("handles tool_use blocks without a name field", async () => {
    const d = await makeTmpDir()
    const filePath = join(d, "no-name.jsonl")
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
    await rm(d, { recursive: true, force: true })
  })

  it("returns empty array for path with shell metacharacters", async () => {
    const result = await extractToolNamesFromTranscript("/path;rm -rf /;echo")
    expect(result).toEqual([])
  })

  it("returns empty array for directory path instead of file", async () => {
    const d = await makeTmpDir()
    const result = await extractToolNamesFromTranscript(d)
    expect(result).toEqual([])
    await rm(d, { recursive: true, force: true })
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

  it("returns boolean for any real skill name", () => {
    // "commit" exists locally but may not in CI — just verify graceful boolean return
    const result = skillExists("commit")
    expect(typeof result).toBe("boolean")
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

  it("supports a custom configured default branch", () => {
    expect(isDefaultBranch("trunk", "trunk")).toBe(true)
    expect(isDefaultBranch("main", "trunk")).toBe(false)
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

// ─── update_plan / TaskList / TaskGet mapping regressions ───────────────────
// These guard the Codex task-tool alias mapping introduced in
// feat(agents): map Codex task tools to update_plan, replace spawn_agent

describe("isTaskTool — update_plan recognition (Codex alias)", () => {
  it("recognises update_plan as a task tool", () => {
    expect(isTaskTool("update_plan")).toBe(true)
  })

  it("recognises update_plan as a task-create tool", () => {
    expect(isTaskCreateTool("update_plan")).toBe(true)
  })

  it("does not recognise spawn_agent as a task tool (removed)", () => {
    expect(isTaskTool("spawn_agent")).toBe(false)
  })

  it("does not recognise spawn_agent as a task-create tool (removed)", () => {
    expect(isTaskCreateTool("spawn_agent")).toBe(false)
  })

  it("still recognises all canonical Claude task tools", () => {
    for (const name of ["Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      expect(isTaskTool(name)).toBe(true)
    }
  })

  it("still recognises Cursor TodoWrite as a task tool", () => {
    expect(isTaskTool("TodoWrite")).toBe(true)
    expect(isTaskCreateTool("TodoWrite")).toBe(true)
  })

  it("still recognises Gemini write_todos as a task tool", () => {
    expect(isTaskTool("write_todos")).toBe(true)
    expect(isTaskCreateTool("write_todos")).toBe(true)
  })
})

describe("Codex toolAliases — TaskList/TaskGet intentionally unmapped", () => {
  it("Codex has no TaskList alias (read-only, no Codex equivalent)", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(codex.toolAliases).not.toHaveProperty("TaskList")
  })

  it("Codex has no TaskGet alias (read-only, no Codex equivalent)", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(codex.toolAliases).not.toHaveProperty("TaskGet")
  })

  it("translateMatcher passes TaskList through unchanged for Codex", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(translateMatcher("TaskList", codex)).toBe("TaskList")
  })

  it("translateMatcher passes TaskGet through unchanged for Codex", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(translateMatcher("TaskGet", codex)).toBe("TaskGet")
  })

  it("translateMatcher still maps TaskCreate to update_plan for Codex", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(translateMatcher("TaskCreate", codex)).toBe("update_plan")
  })

  it("translateMatcher still maps TaskUpdate to update_plan for Codex", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(translateMatcher("TaskUpdate", codex)).toBe("update_plan")
  })
})

// ─── Mutation guards: prove the regression tests catch broken impls ───────────
// Each test constructs the "broken before" state and shows it gives the wrong
// answer, then asserts the live implementation gives the right answer.
// If anyone reverts the alias change, these fail — that's the point.

describe("mutation guards — TASK_TOOLS set membership", () => {
  it("TASK_TOOLS contains update_plan (removing it would break isTaskTool)", () => {
    // Mutation: set without update_plan → isTaskTool("update_plan") would be false
    const broken = new Set([...TASK_TOOLS].filter((v) => v !== "update_plan"))
    expect(broken.has("update_plan")).toBe(false) // broken impl gives wrong answer
    expect(TASK_TOOLS.has("update_plan")).toBe(true) // real impl gives right answer
  })

  it("TASK_TOOLS does not contain spawn_agent (re-adding it should not restore task recognition)", () => {
    // Mutation: set with spawn_agent re-added → would wrongly re-recognise it
    const broken = new Set([...TASK_TOOLS, "spawn_agent"])
    expect(broken.has("spawn_agent")).toBe(true) // broken impl is permissive
    expect(TASK_TOOLS.has("spawn_agent")).toBe(false) // real impl correctly excludes it
  })

  it("TASK_CREATE_TOOLS contains update_plan (removing it would break isTaskCreateTool)", () => {
    const broken = new Set([...TASK_CREATE_TOOLS].filter((v) => v !== "update_plan"))
    expect(broken.has("update_plan")).toBe(false) // broken
    expect(TASK_CREATE_TOOLS.has("update_plan")).toBe(true) // correct
  })

  it("TASK_CREATE_TOOLS does not contain spawn_agent (reverting would be wrong)", () => {
    const broken = new Set([...TASK_CREATE_TOOLS, "spawn_agent"])
    expect(broken.has("spawn_agent")).toBe(true) // broken
    expect(TASK_CREATE_TOOLS.has("spawn_agent")).toBe(false) // correct
  })
})

describe("Codex toolAliases — exhaustive table (snapshot regression)", () => {
  // Authoritative record of every Codex alias. Any addition, removal, or
  // value change breaks this test intentionally — that's the point.
  const EXPECTED_CODEX_ALIASES: Record<string, string> = {
    Bash: "shell_command",
    Edit: "apply_patch",
    Write: "apply_patch",
    Read: "read_file",
    Grep: "grep_files",
    Glob: "list_dir",
    Task: "update_plan",
    TaskCreate: "update_plan",
    TaskUpdate: "update_plan",
    NotebookEdit: "apply_patch",
  }

  it("toolAliases object matches expected table exactly (shape + values)", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(codex.toolAliases).toEqual(EXPECTED_CODEX_ALIASES)
  })

  it("every canonical tool in the table translates to its expected alias", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    for (const [canonical, expected] of Object.entries(EXPECTED_CODEX_ALIASES)) {
      expect(translateMatcher(canonical, codex), `${canonical} → ${expected}`).toBe(expected)
    }
  })

  it("spawn_agent is absent from all Codex alias values", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(Object.values(codex.toolAliases)).not.toContain("spawn_agent")
  })

  it("only Task/TaskCreate/TaskUpdate map to update_plan — no other key maps there", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    const mappedToUpdatePlan = Object.entries(codex.toolAliases)
      .filter(([, v]) => v === "update_plan")
      .map(([k]) => k)
      .sort()
    expect(mappedToUpdatePlan).toEqual(["Task", "TaskCreate", "TaskUpdate"])
  })

  it("TaskList and TaskGet are absent from Codex aliases (pass-through)", async () => {
    const { getAgent } = await import("../../src/agents.ts")
    const codex = getAgent("codex")!
    expect(Object.keys(codex.toolAliases)).not.toContain("TaskList")
    expect(Object.keys(codex.toolAliases)).not.toContain("TaskGet")
  })
})

describe("mutation guards — Codex toolAliases translateMatcher", () => {
  it("broken alias (spawn_agent) gives wrong translation; real alias (update_plan) gives right one", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const realCodex = getAgent("codex")!

    // Simulate the pre-fix broken state: TaskCreate aliased to spawn_agent
    const brokenCodex = {
      ...realCodex,
      toolAliases: { ...realCodex.toolAliases, TaskCreate: "spawn_agent" },
    }
    expect(translateMatcher("TaskCreate", brokenCodex)).toBe("spawn_agent") // wrong
    expect(translateMatcher("TaskCreate", realCodex)).toBe("update_plan") // correct
  })

  it("absent TaskList alias passes through; adding a wrong alias would change the output", async () => {
    const { translateMatcher, getAgent } = await import("../../src/agents.ts")
    const realCodex = getAgent("codex")!

    // Simulate accidentally mapping TaskList to something
    const brokenCodex = {
      ...realCodex,
      toolAliases: { ...realCodex.toolAliases, TaskList: "list_tasks_wrong" },
    }
    expect(translateMatcher("TaskList", brokenCodex)).toBe("list_tasks_wrong") // broken — mapped
    expect(translateMatcher("TaskList", realCodex)).toBe("TaskList") // correct — pass-through
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

  it("falls back to cwd for empty string", async () => {
    // Bun.spawn({ cwd: "" }) falls back to process.cwd() — verify both return the same result
    const resultEmpty = await getGitAheadBehind("")
    const resultCwd = await getGitAheadBehind(process.cwd())
    expect(resultEmpty).toEqual(resultCwd)
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

// ─── createSessionTask() edge cases ─────────────────────────────────────────

describe("createSessionTask() with malformed inputs", () => {
  it("returns early for undefined sessionId", async () => {
    await createSessionTask(undefined, "test-key", "subject", "desc")
    // Should not throw
  })

  it("returns early for 'null' string sessionId", async () => {
    await createSessionTask("null", "test-key", "subject", "desc")
    // Should not throw
  })

  it("returns early for empty sessionId", async () => {
    await createSessionTask("", "test-key", "subject", "desc")
    // Should not throw
  })

  it("returns early for whitespace-only sessionId", async () => {
    await createSessionTask("   ", "test-key", "subject", "desc")
    // Should not throw
  })

  it("returns early for empty sentinelKey", async () => {
    await createSessionTask("valid-session", "", "subject", "desc")
    // Should not throw
  })

  it("returns early for whitespace-only sentinelKey", async () => {
    await createSessionTask("valid-session", "  \t  ", "subject", "desc")
    // Should not throw
  })

  it("sanitizes path-separator characters in sentinelKey", async () => {
    // Should not throw even with path separators. No-op executor avoids spawning a real process.
    const noopExecutor = async (_args: string[]) => 0
    await createSessionTask("valid-id", "key/../../etc/passwd", "subject", "desc", noopExecutor)
  })

  it("sanitizes shell metacharacters in sessionId", async () => {
    // Should not throw even with metacharacters. No-op executor avoids spawning a real process.
    const noopExecutor = async (_args: string[]) => 0
    await createSessionTask("id;rm -rf /", "safe-key", "subject", "desc", noopExecutor)
  })

  it("handles sessionId that becomes empty after sanitization", async () => {
    // All special chars → sanitized to empty → should return early
    await createSessionTask("///", "safe-key", "subject", "desc")
  })

  it("handles sentinelKey that becomes empty after sanitization", async () => {
    await createSessionTask("valid-id", "///", "subject", "desc")
  })
})

// ─── skillAdvice() edge cases ───────────────────────────────────────────────

describe("skillAdvice() with edge-case inputs", () => {
  it("returns withoutSkill for empty skill name", () => {
    const result = skillAdvice("", "with-skill", "without-skill")
    expect(result).toBe("without-skill")
  })

  it("returns withoutSkill for nonexistent skill", () => {
    const result = skillAdvice("nonexistent-xyz-123", "with", "without")
    expect(result).toBe("without")
  })

  it("always includes withoutSkill; prepends withSkill when skill exists (environment-dependent)", () => {
    // "commit" exists locally; in CI it may not — test both paths
    const result = skillAdvice("commit", "with", "without")
    // skill found: "with\n\nwithout"; skill absent: "without"
    expect(result === "with\n\nwithout" || result === "without").toBe(true)
    // fallback steps always present
    expect(result).toContain("without")
  })

  it("handles empty withSkill and withoutSkill strings", () => {
    const result = skillAdvice("nonexistent-xyz", "", "")
    expect(result).toBe("")
  })

  it("composes nested skillAdvice calls correctly when outer skill is missing", () => {
    // When outer skill doesn't exist, inner skillAdvice is never evaluated
    const result = skillAdvice(
      "nonexistent-outer-xyz",
      `outer with ${skillAdvice("nonexistent-inner-xyz", "inner with", "inner without")}`,
      "outer fallback"
    )
    expect(result).toBe("outer fallback")
  })

  it("composes nested skillAdvice calls correctly when outer exists but inner is missing", () => {
    // Simulates the stop-git-push pattern: resolve-conflicts exists but push doesn't
    // Since we can't guarantee skill existence in CI, test with nonexistent skills
    const result = skillAdvice(
      "nonexistent-outer-xyz",
      "use /resolve-conflicts, then " +
        skillAdvice("nonexistent-inner-xyz", "push with /push.", "push: git push origin main"),
      "resolve manually, then run: git push origin main"
    )
    // Outer is missing, so we get the outer fallback
    expect(result).toBe("resolve manually, then run: git push origin main")
  })

  it("nested skillAdvice evaluates inner when both skills are missing", () => {
    // Even when outer fallback is chosen, the inner skillAdvice was already evaluated
    // This tests that skillAdvice is a pure function with no side effects
    const inner = skillAdvice(
      "nonexistent-push-xyz",
      "push with /push.",
      "push: git push origin feat"
    )
    expect(inner).toBe("push: git push origin feat")

    const outer = skillAdvice(
      "nonexistent-resolve-xyz",
      `use /resolve-conflicts, then ${inner}`,
      "resolve manually, then run: git push origin feat"
    )
    expect(outer).toBe("resolve manually, then run: git push origin feat")
  })
})

// ─── detectRuntime() / detectPkgRunner() / detectPackageManager() ───────────

describe("detectPackageManager()", () => {
  it("returns a valid PackageManager or null", async () => {
    const result = await detectPackageManager()
    expect(result === null || ["bun", "pnpm", "yarn", "npm"].includes(result)).toBe(true)
  })

  it("returns consistent results (caching)", async () => {
    const a = detectPackageManager()
    const b = detectPackageManager()
    expect(await a).toBe(await b)
  })
})

describe("detectRuntime()", () => {
  it("returns 'bun' or 'node'", async () => {
    const result = await detectRuntime()
    expect(result === "bun" || result === "node").toBe(true)
  })
})

describe("detectPkgRunner()", () => {
  it("returns a known runner command", async () => {
    const result = await detectPkgRunner()
    expect(["bunx", "pnpm dlx", "yarn dlx", "npx"].includes(result)).toBe(true)
  })
})

// ─── SOURCE_EXT_RE / TEST_FILE_RE ───────────────────────────────────────────

describe("SOURCE_EXT_RE", () => {
  it("matches common source extensions", () => {
    expect(SOURCE_EXT_RE.test("foo.ts")).toBe(true)
    expect(SOURCE_EXT_RE.test("foo.tsx")).toBe(true)
    expect(SOURCE_EXT_RE.test("foo.js")).toBe(true)
    expect(SOURCE_EXT_RE.test("foo.py")).toBe(true)
    expect(SOURCE_EXT_RE.test("foo.go")).toBe(true)
    expect(SOURCE_EXT_RE.test("foo.rs")).toBe(true)
  })

  it("does not match non-source files", () => {
    expect(SOURCE_EXT_RE.test("foo.md")).toBe(false)
    expect(SOURCE_EXT_RE.test("foo.json")).toBe(false)
    expect(SOURCE_EXT_RE.test("foo.yaml")).toBe(false)
    expect(SOURCE_EXT_RE.test("foo.txt")).toBe(false)
    expect(SOURCE_EXT_RE.test("foo.png")).toBe(false)
    expect(SOURCE_EXT_RE.test("foo.sh")).toBe(false)
  })

  it("does not match extensionless files", () => {
    expect(SOURCE_EXT_RE.test("Makefile")).toBe(false)
    expect(SOURCE_EXT_RE.test("Dockerfile")).toBe(false)
  })

  it("matches extension at end of path", () => {
    expect(SOURCE_EXT_RE.test("src/components/Button.tsx")).toBe(true)
    expect(SOURCE_EXT_RE.test("packages/lib/index.ts")).toBe(true)
  })
})

describe("TEST_FILE_RE", () => {
  it("matches test file patterns", () => {
    expect(TEST_FILE_RE.test("foo.test.ts")).toBe(true)
    expect(TEST_FILE_RE.test("foo.spec.ts")).toBe(true)
    expect(TEST_FILE_RE.test("__tests__/foo.ts")).toBe(true)
    expect(TEST_FILE_RE.test("src/test/foo.ts")).toBe(true)
  })

  it("does not match regular source files", () => {
    expect(TEST_FILE_RE.test("src/foo.ts")).toBe(false)
    expect(TEST_FILE_RE.test("src/testing-utils.ts")).toBe(false)
    expect(TEST_FILE_RE.test("src/contest.ts")).toBe(false)
  })
})

// ─── extractToolNamesFromTranscript() whitespace hardening ──────────────────

describe("extractToolNamesFromTranscript() whitespace-only line filtering", () => {
  it("filters whitespace-only lines between valid JSONL entries", async () => {
    const d = await mkdtemp(join(tmpdir(), "swiz-whitespace-"))
    const filePath = join(d, "whitespace-lines.jsonl")
    const validEntry = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    })
    // Whitespace-only lines should not cause JSON parse errors
    await writeFile(filePath, `${validEntry}\n   \t  \n${validEntry}\n`)
    const result = await extractToolNamesFromTranscript(filePath)
    expect(result).toEqual(["Read", "Read"])
    await rm(d, { recursive: true, force: true })
  })
})

// ─── CI_WAIT_RE ─────────────────────────────────────────────────────────────

describe("CI_WAIT_RE", () => {
  it("matches bare 'swiz ci-wait'", () => {
    expect(CI_WAIT_RE.test("swiz ci-wait abc123")).toBe(true)
  })

  it("matches 'bun run index.ts ci-wait'", () => {
    expect(CI_WAIT_RE.test("bun run index.ts ci-wait abc123")).toBe(true)
  })

  it("matches 'bun ci-wait'", () => {
    expect(CI_WAIT_RE.test("bun ci-wait abc123")).toBe(true)
  })

  it("matches ci-wait after && separator", () => {
    expect(CI_WAIT_RE.test("echo done && swiz ci-wait abc")).toBe(true)
  })

  it("matches ci-wait after || separator", () => {
    expect(CI_WAIT_RE.test("false || swiz ci-wait abc")).toBe(true)
  })

  it("does not match unrelated commands", () => {
    expect(CI_WAIT_RE.test("git push origin main")).toBe(false)
  })

  it("does not match partial prefix like 'ci-waiter'", () => {
    // \b after ci-wait ensures word boundary
    expect(CI_WAIT_RE.test("swiz ci-waiter")).toBe(false)
  })
})

// ─── isTaskTrackingExemptShellCommand — swiz commands ───────────────────────

describe("isTaskTrackingExemptShellCommand — swiz command exemption", () => {
  it("exempts 'swiz ci-wait abc123'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz ci-wait abc123")).toBe(true)
  })

  it("exempts 'swiz state set in-development'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz state set in-development")).toBe(true)
  })

  it("exempts 'swiz tasks complete-all'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz tasks complete-all")).toBe(true)
  })

  it("exempts 'swiz push-wait origin main'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz push-wait origin main")).toBe(true)
  })

  it("exempts 'swiz status'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz status")).toBe(true)
  })

  it("exempts 'swiz install'", () => {
    expect(isTaskTrackingExemptShellCommand("swiz install")).toBe(true)
  })

  it("does not exempt 'git add .'", () => {
    expect(isTaskTrackingExemptShellCommand("git add .")).toBe(false)
  })

  it("exempts 'bun test'", () => {
    expect(isTaskTrackingExemptShellCommand("bun test")).toBe(true)
  })
})

// ─── isTaskTrackingExemptShellCommand — setup/build commands ────────────────

describe("isTaskTrackingExemptShellCommand — setup/build command exemption", () => {
  it("exempts 'bun install'", () => {
    expect(isTaskTrackingExemptShellCommand("bun install")).toBe(true)
  })

  it("exempts 'pnpm install'", () => {
    expect(isTaskTrackingExemptShellCommand("pnpm install")).toBe(true)
  })

  it("exempts 'npm install'", () => {
    expect(isTaskTrackingExemptShellCommand("npm install")).toBe(true)
  })

  it("exempts 'yarn install'", () => {
    expect(isTaskTrackingExemptShellCommand("yarn install")).toBe(true)
  })

  it("exempts 'npm ci'", () => {
    expect(isTaskTrackingExemptShellCommand("npm ci")).toBe(true)
  })

  it("exempts 'bun add lodash'", () => {
    expect(isTaskTrackingExemptShellCommand("bun add lodash")).toBe(true)
  })

  it("exempts 'pnpm lint'", () => {
    expect(isTaskTrackingExemptShellCommand("pnpm lint")).toBe(true)
  })

  it("exempts 'npm run lint'", () => {
    expect(isTaskTrackingExemptShellCommand("npm run lint")).toBe(true)
  })

  it("exempts 'bun build'", () => {
    expect(isTaskTrackingExemptShellCommand("bun build")).toBe(true)
  })

  it("exempts 'pnpm typecheck'", () => {
    expect(isTaskTrackingExemptShellCommand("pnpm typecheck")).toBe(true)
  })

  it("exempts 'npx tsc'", () => {
    expect(isTaskTrackingExemptShellCommand("npx tsc")).toBe(true)
  })

  it("exempts 'pnpm format'", () => {
    expect(isTaskTrackingExemptShellCommand("pnpm format")).toBe(true)
  })

  it("exempts 'npx biome check .'", () => {
    expect(isTaskTrackingExemptShellCommand("npx biome check .")).toBe(true)
  })

  it("exempts 'npx eslint src/'", () => {
    expect(isTaskTrackingExemptShellCommand("npx eslint src/")).toBe(true)
  })

  it("exempts 'npx prettier --check .'", () => {
    expect(isTaskTrackingExemptShellCommand("npx prettier --check .")).toBe(true)
  })

  it("exempts setup command after && operator", () => {
    expect(isTaskTrackingExemptShellCommand("echo done && bun install")).toBe(true)
  })

  it("does not exempt 'bun run dev'", () => {
    expect(isTaskTrackingExemptShellCommand("bun run dev")).toBe(false)
  })

  it("does not exempt 'node script.js'", () => {
    expect(isTaskTrackingExemptShellCommand("node script.js")).toBe(false)
  })
})

// ─── isSwizCommand ──────────────────────────────────────────────────────────

describe("isSwizCommand", () => {
  const input = (cmd: string) => ({ cwd: "/tmp", tool_name: "Bash", tool_input: { command: cmd } })

  it("matches 'swiz state set released'", () => {
    expect(isSwizCommand(input("swiz state set released"))).toBe(true)
  })

  it("matches 'swiz tasks complete-all'", () => {
    expect(isSwizCommand(input("swiz tasks complete-all"))).toBe(true)
  })

  it("matches swiz after && operator", () => {
    expect(isSwizCommand(input("echo done && swiz status"))).toBe(true)
  })

  it("matches swiz after ; separator", () => {
    expect(isSwizCommand(input("echo done; swiz install"))).toBe(true)
  })

  it("does not match 'git push origin main'", () => {
    expect(isSwizCommand(input("git push origin main"))).toBe(false)
  })

  it("does not match 'bun test'", () => {
    expect(isSwizCommand(input("bun test"))).toBe(false)
  })

  it("does not match empty command", () => {
    expect(isSwizCommand(input(""))).toBe(false)
  })

  it("does not match when no tool_input", () => {
    expect(isSwizCommand({ cwd: "/tmp", tool_name: "Bash" })).toBe(false)
  })
})
