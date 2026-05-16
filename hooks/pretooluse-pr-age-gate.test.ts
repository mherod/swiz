import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  extractMergeBranch,
  extractPrNumber,
  GH_PR_MERGE_RE,
  GIT_MERGE_RE,
} from "../src/utils/hook-utils.ts"
import { evaluatePretoolusePrAgeGate, formatRemaining } from "./pretooluse-pr-age-gate.ts"

// ── collab-mode bypass ───────────────────────────────────────────────────────

describe("collab-mode bypass", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pr-age-gate-test-"))
  })

  afterAll(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function makeProjectDir(collaborationMode: string): Promise<string> {
    const projectDir = await mkdtemp(join(tmpDir, `proj-`))
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await Bun.write(
      join(swizDir, "config.json"),
      JSON.stringify({ collaborationMode, prAgeGateMinutes: 10 })
    )
    return projectDir
  }

  function makeInput(command: string, cwd: string): unknown {
    return {
      tool_name: "Bash",
      tool_input: { command, cwd },
      cwd,
      session_id: "test-session",
      transcript_path: "/dev/null",
    }
  }

  it("bypasses grace period when collab-mode is solo", async () => {
    const projectDir = await makeProjectDir("solo")
    const result = await evaluatePretoolusePrAgeGate(
      makeInput("gh pr merge 42 --squash", projectDir)
    )
    // Solo mode: prHooksActive=false → early return {} before any gh call
    expect(result).toEqual({})
  })

  it("bypasses grace period when collab-mode is auto", async () => {
    const projectDir = await makeProjectDir("auto")
    const result = await evaluatePretoolusePrAgeGate(
      makeInput("gh pr merge 15 --squash", projectDir)
    )
    // Auto mode: prHooksActive=false → early return {}
    expect(result).toEqual({})
  })

  it("does not bypass grace period for non-merge commands even in solo mode", async () => {
    const projectDir = await makeProjectDir("solo")
    const result = await evaluatePretoolusePrAgeGate(makeInput("gh pr list", projectDir))
    // Not a merge command → returns {} immediately (no gate applicable)
    expect(result).toEqual({})
  })

  it("passes through non-shell tool inputs regardless of collab-mode", async () => {
    const projectDir = await makeProjectDir("team")
    const result = await evaluatePretoolusePrAgeGate({
      tool_name: "Edit",
      tool_input: { path: "foo.ts" },
      cwd: projectDir,
      session_id: "test-session",
      transcript_path: "/dev/null",
    })
    expect(result).toEqual({})
  })
})

// ── GH_PR_MERGE_RE ─────────────────────────────────────────────────────────

describe("GH_PR_MERGE_RE", () => {
  describe("matches gh pr merge commands", () => {
    it("matches plain gh pr merge", () => {
      expect(GH_PR_MERGE_RE.test("gh pr merge 42")).toBe(true)
    })
    it("matches gh pr merge without number", () => {
      expect(GH_PR_MERGE_RE.test("gh pr merge")).toBe(true)
    })
    it("matches gh pr merge with --squash", () => {
      expect(GH_PR_MERGE_RE.test("gh pr merge 42 --squash")).toBe(true)
    })
    it("matches in && chain", () => {
      expect(GH_PR_MERGE_RE.test("echo ok && gh pr merge 42")).toBe(true)
    })
    it("matches in ; chain", () => {
      expect(GH_PR_MERGE_RE.test("echo ok; gh pr merge 42")).toBe(true)
    })
    it("matches in || chain", () => {
      expect(GH_PR_MERGE_RE.test("gh pr merge 42 || echo failed")).toBe(true)
    })
  })

  describe("does not match non-merge commands", () => {
    it("does not match gh pr view", () => {
      expect(GH_PR_MERGE_RE.test("gh pr view 42")).toBe(false)
    })
    it("does not match gh pr list", () => {
      expect(GH_PR_MERGE_RE.test("gh pr list")).toBe(false)
    })
    it("does not match git push", () => {
      expect(GH_PR_MERGE_RE.test("git push origin main")).toBe(false)
    })
    it("does not match echo containing gh pr merge", () => {
      expect(GH_PR_MERGE_RE.test('echo "run gh pr merge"')).toBe(false)
    })
  })
})

// ── GIT_MERGE_RE ────────────────────────────────────────────────────────────

describe("GIT_MERGE_RE", () => {
  describe("matches git merge commands", () => {
    it("matches plain git merge", () => {
      expect(GIT_MERGE_RE.test("git merge feature-branch")).toBe(true)
    })
    it("matches git merge with --no-ff", () => {
      expect(GIT_MERGE_RE.test("git merge --no-ff feature-branch")).toBe(true)
    })
    it("matches git merge with --squash", () => {
      expect(GIT_MERGE_RE.test("git merge --squash feature-branch")).toBe(true)
    })
    it("matches in && chain", () => {
      expect(GIT_MERGE_RE.test("git fetch && git merge origin/feature")).toBe(true)
    })
    it("matches at start of command", () => {
      expect(GIT_MERGE_RE.test("git merge my-branch")).toBe(true)
    })
  })

  describe("does not match non-merge commands", () => {
    it("does not match git push", () => {
      expect(GIT_MERGE_RE.test("git push origin main")).toBe(false)
    })
    it("does not match git mergetool", () => {
      expect(GIT_MERGE_RE.test("git mergetool")).toBe(false)
    })
  })
})

// ── extractPrNumber ─────────────────────────────────────────────────────────

describe("extractPrNumber", () => {
  it("extracts PR number from gh pr merge 42", () => {
    expect(extractPrNumber("gh pr merge 42")).toBe("42")
  })
  it("extracts PR number with flags", () => {
    expect(extractPrNumber("gh pr merge 123 --squash --auto")).toBe("123")
  })
  it("returns null when no number present", () => {
    expect(extractPrNumber("gh pr merge --squash")).toBeNull()
  })
  it("returns null for non-merge commands", () => {
    expect(extractPrNumber("gh pr view 42")).toBeNull()
  })
})

// ── extractMergeBranch ──────────────────────────────────────────────────────

describe("extractMergeBranch", () => {
  it("extracts branch from git merge feature-branch", () => {
    expect(extractMergeBranch("git merge feature-branch")).toBe("feature-branch")
  })
  it("extracts branch from git merge origin/feature", () => {
    expect(extractMergeBranch("git merge origin/feature")).toBe("origin/feature")
  })
  it("extracts branch with --no-ff flag", () => {
    expect(extractMergeBranch("git merge --no-ff feature-branch")).toBe("feature-branch")
  })
  it("extracts branch with --squash flag", () => {
    expect(extractMergeBranch("git merge --squash feature-branch")).toBe("feature-branch")
  })
  it("extracts branch with multiple flags", () => {
    expect(extractMergeBranch("git merge --no-ff --no-edit feature-branch")).toBe("feature-branch")
  })
  it("returns null when only flags present", () => {
    expect(extractMergeBranch("git merge --abort")).toBeNull()
  })
  it("returns null for empty merge", () => {
    expect(extractMergeBranch("git merge")).toBeNull()
  })
})

// ── formatRemaining ─────────────────────────────────────────────────────────

describe("formatRemaining", () => {
  it("formats seconds only", () => {
    expect(formatRemaining(45_000)).toBe("45s")
  })
  it("formats minutes and seconds", () => {
    expect(formatRemaining(6 * 60_000 + 30_000)).toBe("6m 30s")
  })
  it("formats exact minutes", () => {
    expect(formatRemaining(10 * 60_000)).toBe("10m 0s")
  })
  it("rounds up sub-second values", () => {
    expect(formatRemaining(500)).toBe("1s")
  })
  it("formats 1 second", () => {
    expect(formatRemaining(1000)).toBe("1s")
  })
  it("formats 0ms as 0s", () => {
    expect(formatRemaining(0)).toBe("0s")
  })
})
