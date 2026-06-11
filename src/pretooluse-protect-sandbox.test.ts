import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSandboxDisableCommand } from "../hooks/pretooluse-protect-sandbox.ts"
import {
  isProtectedTaskStoragePath,
  isProtectedTaskStoragePathResolved,
  isSafeReadOnlyShellCommand,
} from "../hooks/sandbox-path-utils.ts"

describe("isSandboxDisableCommand", () => {
  // ── disable subcommand ────────────────────────────────────────────────────

  it("blocks: swiz settings disable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxededits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxededits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxed_edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed_edits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxedEdits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxedEdits")).toBe(true)
  })

  // ── set … false path ──────────────────────────────────────────────────────

  it("blocks: swiz settings set sandboxed-edits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed-edits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxededits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxededits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxed_edits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed_edits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxedEdits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxedEdits false")).toBe(true)
  })

  // ── extra whitespace / flags ──────────────────────────────────────────────

  it("blocks command with trailing whitespace", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits  ")).toBe(true)
  })

  it("blocks command embedded in a longer script", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits && echo done")).toBe(true)
  })

  // ── allowed commands ──────────────────────────────────────────────────────

  it("allows: swiz settings disable other-setting", () => {
    expect(isSandboxDisableCommand("swiz settings disable other-setting")).toBe(false)
  })

  it("allows: swiz settings enable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings enable sandboxed-edits")).toBe(false)
  })

  it("allows: swiz settings set sandboxed-edits true", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed-edits true")).toBe(false)
  })

  it("allows: unrelated bash command", () => {
    expect(isSandboxDisableCommand("git status")).toBe(false)
  })

  it("allows: empty string", () => {
    expect(isSandboxDisableCommand("")).toBe(false)
  })
})

describe("isSafeReadOnlyShellCommand", () => {
  it("allows simple read-only inspection commands", () => {
    expect(isSafeReadOnlyShellCommand("cat ~/.swiz/settings.json")).toBe(true)
    expect(isSafeReadOnlyShellCommand("head -n 20 ~/.swiz/settings.json")).toBe(true)
    expect(isSafeReadOnlyShellCommand("tail -n 20 ~/.swiz/settings.json")).toBe(true)
    expect(isSafeReadOnlyShellCommand("grep foo ~/.swiz/settings.json | head -n 5")).toBe(true)
    expect(isSafeReadOnlyShellCommand("sed -n '1,10p' ~/.swiz/settings.json")).toBe(true)
    expect(isSafeReadOnlyShellCommand("rg foo ~/.swiz/settings.json")).toBe(true)
  })

  it("rejects chaining, redirects, and command substitution", () => {
    expect(isSafeReadOnlyShellCommand("cat ~/.swiz/settings.json && echo done")).toBe(false)
    expect(isSafeReadOnlyShellCommand("cat ~/.swiz/settings.json > /tmp/out")).toBe(false)
    expect(isSafeReadOnlyShellCommand("sed -i 's/foo/bar/' ~/.swiz/settings.json")).toBe(false)
    expect(isSafeReadOnlyShellCommand('cat $(printf "%s" "$HOME")/.swiz/settings.json')).toBe(false)
  })

  it("allows benign stderr/null redirections on read-only commands", () => {
    expect(isSafeReadOnlyShellCommand("ls -la ~/.gemini 2>&1 | head -50")).toBe(true)
    expect(isSafeReadOnlyShellCommand("ls -la ~/.gemini 2>/dev/null")).toBe(true)
    expect(isSafeReadOnlyShellCommand("rg --files ~/.gemini 2>/dev/null | head -100")).toBe(true)
    expect(isSafeReadOnlyShellCommand("cat ~/.swiz/settings.json 2>&1")).toBe(true)
    expect(isSafeReadOnlyShellCommand("ls ~/.gemini &>/dev/null")).toBe(true)
  })

  it("still rejects redirects that write to real files", () => {
    expect(isSafeReadOnlyShellCommand("ls -la ~/.gemini > /tmp/out")).toBe(false)
    expect(isSafeReadOnlyShellCommand("cat ~/.swiz/settings.json 2>/tmp/err")).toBe(false)
  })
})

describe("isProtectedTaskStoragePath", () => {
  it("matches agent task storage roots", () => {
    expect(isProtectedTaskStoragePath("/Users/dev/.claude/tasks/session/1.json")).toBe(true)
    expect(isProtectedTaskStoragePath("/Users/dev/.codex/tasks/session/1.json")).toBe(true)
    expect(isProtectedTaskStoragePath("/Users/dev/.Codex/tasks/session/1.json")).toBe(true)
  })

  it("does not match non-task hidden home paths", () => {
    expect(isProtectedTaskStoragePath("/Users/dev/.swiz/settings.json")).toBe(false)
    expect(isProtectedTaskStoragePath("/Users/dev/.claude/skills/commit/SKILL.md")).toBe(false)
  })
})

describe("isProtectedTaskStoragePathResolved", () => {
  it("keeps matching literal task paths via the sync fast path", async () => {
    expect(await isProtectedTaskStoragePathResolved("/Users/dev/.claude/tasks/1.json")).toBe(true)
    expect(await isProtectedTaskStoragePathResolved("~/.claude/tasks/1.json")).toBe(true)
  })

  it("returns false for empty input", async () => {
    expect(await isProtectedTaskStoragePathResolved("")).toBe(false)
  })

  it("resolves a symlink whose target is inside the tasks dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-guard-"))
    try {
      const realTasks = join(base, ".claude", "tasks")
      await mkdir(realTasks, { recursive: true })
      await writeFile(join(realTasks, "1.json"), "{}")
      const link = join(base, "link")
      await symlink(realTasks, link)
      // The link path has no literal `.claude/tasks` segment; only realpath reveals it.
      expect(link.includes(".claude/tasks")).toBe(false)
      expect(await isProtectedTaskStoragePathResolved(join(link, "1.json"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it("does not match a symlink to an unrelated directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-guard-"))
    try {
      const realDir = join(base, "data", "store")
      await mkdir(realDir, { recursive: true })
      const link = join(base, "link")
      await symlink(realDir, link)
      expect(await isProtectedTaskStoragePathResolved(join(link, "1.json"))).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
