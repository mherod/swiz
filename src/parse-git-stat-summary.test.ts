import { describe, expect, it } from "bun:test"
import {
  classifyChangeScope,
  type GitStatSummary,
  parseGitStatSummary,
} from "../hooks/hook-utils.ts"

describe("parseGitStatSummary", () => {
  it("parses both insertions and deletions", () => {
    const input = ` README.md          |   5 +-
 hooks/scope-gate.ts | 156 +++++++++++++++++++++
 src/manifest.ts     |   1 +
 3 files changed, 160 insertions(+), 2 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 3,
      insertions: 160,
      deletions: 2,
    })
  })

  it("parses insertions only (no deletions)", () => {
    const input = ` src/api/users.ts  |  15 +++++++++++++++
 src/types/user.ts |   6 ++++++
 2 files changed, 21 insertions(+)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 2,
      insertions: 21,
      deletions: 0,
    })
  })

  it("parses deletions only (no insertions)", () => {
    const input = ` src/deprecated.ts | 45 -----------------------------------------
 1 file changed, 45 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 45,
    })
  })

  it("parses rename only (no content change)", () => {
    // git outputs just "N file(s) changed" with no insertions/deletions
    const input = ` src/{old.ts => new.ts} | 0
 1 file changed`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })

  it("parses single file singular form", () => {
    const input = ` hooks/gate.ts | 14 ++++++++------
 1 file changed, 8 insertions(+), 6 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 8,
      deletions: 6,
    })
  })

  it("parses single insertion singular form", () => {
    const input = ` config.json | 1 +
 1 file changed, 1 insertion(+)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    })
  })

  it("parses single deletion singular form", () => {
    const input = ` config.json | 1 -
 1 file changed, 1 deletion(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 1,
    })
  })

  it("parses binary file with zero counts", () => {
    const input = ` image.png | Bin 0 -> 12345 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for empty string", () => {
    expect(parseGitStatSummary("")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for whitespace-only string", () => {
    expect(parseGitStatSummary("  \n  \n  ")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for string with no summary line", () => {
    // Just file lines, no summary — shouldn't happen in practice but must not crash
    expect(parseGitStatSummary(" hooks/gate.ts | 14 ++++++++------")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("handles large numbers", () => {
    const input = ` 15 files changed, 2847 insertions(+), 1203 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 15,
      insertions: 2847,
      deletions: 1203,
    })
  })

  it("handles binary-only change (no summary with counts)", () => {
    // Some binary-only changes show "Bin X -> Y bytes" without insertions/deletions line
    const input = ` image.png | Bin 1234 -> 5678 bytes
 1 file changed`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })
})

// ─── classifyChangeScope ────────────────────────────────────────────────

describe("classifyChangeScope", () => {
  const stat = (f: number, i: number, d: number): GitStatSummary => ({
    filesChanged: f,
    insertions: i,
    deletions: d,
  })

  // ── Fail-closed: stat parsing failed ────────────────────────────────

  it("detects stat parsing failure when files exist but stat is zero", () => {
    const result = classifyChangeScope(stat(0, 0, 0), ["src/app.ts"])
    expect(result.statParsingFailed).toBe(true)
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
    expect(result.scopeDescription).toContain("stat-unparseable")
    expect(result.scopeDescription).toContain("1 files detected")
  })

  it("stat parsing failure with multiple files", () => {
    const result = classifyChangeScope(stat(0, 0, 0), ["a.ts", "b.ts", "c.ts"])
    expect(result.statParsingFailed).toBe(true)
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
    expect(result.scopeDescription).toContain("3 files detected")
  })

  it("no failure when both stat and file list are empty (no changes)", () => {
    const result = classifyChangeScope(stat(0, 0, 0), [])
    expect(result.statParsingFailed).toBe(false)
    // Zero files, zero lines → trivial
    expect(result.isTrivial).toBe(true)
  })

  // ── Trivial classification ──────────────────────────────────────────

  it("classifies small doc change as trivial", () => {
    const result = classifyChangeScope(stat(1, 5, 2), ["README.md"])
    expect(result.isTrivial).toBe(true)
    expect(result.isDocsOnly).toBe(true)
    expect(result.scopeDescription).toBe("docs-only")
  })

  it("classifies small config change as trivial", () => {
    const result = classifyChangeScope(stat(2, 10, 3), ["tsconfig.json", ".eslintrc.yaml"])
    expect(result.isTrivial).toBe(true)
    expect(result.isDocsOnly).toBe(true)
  })

  it("classifies small non-src change as trivial", () => {
    const result = classifyChangeScope(stat(2, 8, 4), ["hooks/gate.ts", "scripts/build.sh"])
    expect(result.isTrivial).toBe(true)
    expect(result.scopeDescription).toBe("trivial")
  })

  // ── Non-trivial: src files ──────────────────────────────────────────

  it("rejects trivial when src/ files are changed even if small", () => {
    const result = classifyChangeScope(stat(1, 5, 2), ["src/app.ts"])
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(true)
    expect(result.scopeDescription).toBe("small-fix")
  })

  it("rejects trivial when lib/ files are changed", () => {
    const result = classifyChangeScope(stat(1, 3, 1), ["lib/utils.ts"])
    expect(result.isTrivial).toBe(false)
  })

  it("rejects trivial when components/ files are changed", () => {
    const result = classifyChangeScope(stat(1, 3, 1), ["components/Button.tsx"])
    expect(result.isTrivial).toBe(false)
  })

  // ── Non-trivial: too many files ─────────────────────────────────────

  it("rejects trivial when > 3 files changed", () => {
    const result = classifyChangeScope(stat(4, 15, 5), ["a.ts", "b.ts", "c.ts", "d.ts"])
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
    expect(result.scopeDescription).toBe("4-files, 20-lines")
  })

  // ── Non-trivial: too many lines ─────────────────────────────────────

  it("rejects trivial when > 20 lines changed", () => {
    const result = classifyChangeScope(stat(2, 15, 10), ["hooks/a.ts", "hooks/b.ts"])
    expect(result.isTrivial).toBe(false)
    // 25 lines > 20 but 2 files ≤ 2 and 25 lines ≤ 30 → small-fix
    expect(result.isSmallFix).toBe(true)
    expect(result.scopeDescription).toBe("small-fix")
  })

  it("rejects small-fix when > 30 lines changed", () => {
    const result = classifyChangeScope(stat(2, 20, 15), ["hooks/a.ts", "hooks/b.ts"])
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
    expect(result.scopeDescription).toBe("2-files, 35-lines")
  })

  // ── Large non-trivial ───────────────────────────────────────────────

  it("classifies large change correctly", () => {
    const result = classifyChangeScope(stat(10, 500, 200), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "lib/f.ts",
      "lib/g.ts",
      "lib/h.ts",
      "lib/i.ts",
      "lib/j.ts",
    ])
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
    expect(result.scopeDescription).toBe("10-files, 700-lines")
  })

  // ── Docs-only detection ─────────────────────────────────────────────

  it("detects docs-only when all files match docs pattern", () => {
    const result = classifyChangeScope(stat(3, 50, 20), [
      "README.md",
      "docs/api.md",
      "CHANGELOG.md",
    ])
    expect(result.isDocsOnly).toBe(true)
  })

  it("rejects docs-only when mixed with code files", () => {
    const result = classifyChangeScope(stat(2, 30, 10), ["README.md", "src/app.ts"])
    expect(result.isDocsOnly).toBe(false)
  })

  // ── Deletions-only stat ─────────────────────────────────────────────

  it("handles deletions-only stat correctly", () => {
    const result = classifyChangeScope(stat(1, 0, 45), ["src/deprecated.ts"])
    expect(result.statParsingFailed).toBe(false)
    expect(result.fileCount).toBe(1)
    expect(result.totalLinesChanged).toBe(45)
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)
  })

  // ── Rename-only (zero insertions/deletions but fileCount > 0) ──────

  it("handles rename-only stat (fileCount > 0 but zero lines)", () => {
    const result = classifyChangeScope(stat(1, 0, 0), ["src/renamed.ts"])
    expect(result.statParsingFailed).toBe(false)
    // fileCount=1 so stat didn't fail; 0 lines but src/ → not trivial
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(true)
  })

  // ── Fail-closed deny message construction ─────────────────────────

  it("produces actionable deny message when stat parsing fails", () => {
    const changedFiles = ["src/api.ts", "src/types.ts", "lib/utils.ts"]
    const result = classifyChangeScope(stat(0, 0, 0), changedFiles)

    // Verify classification triggers fail-closed
    expect(result.statParsingFailed).toBe(true)
    expect(result.isTrivial).toBe(false)
    expect(result.isSmallFix).toBe(false)

    // Construct the deny message exactly as the hook does
    const branch = "main"
    const repo = "owner/repo"
    const message = [
      `Push blocked: git diff --stat could not be parsed, but ${changedFiles.length} file(s) were detected via --name-only.`,
      `Scope: ${result.scopeDescription}`,
      `Repository: ${repo}`,
      "Detected files:",
      ...changedFiles.map((f) => `  - ${f}`),
      "This is a fail-closed guard — when change scope cannot be determined, the push is blocked to prevent unreviewed changes.",
      "Remediation:",
      `  1. Run: git diff --stat origin/${branch}..HEAD`,
    ].join("\n")

    // Verify the message contains all actionable elements
    expect(message).toContain("Push blocked")
    expect(message).toContain("3 file(s) were detected")
    expect(message).toContain("stat-unparseable")
    expect(message).toContain("3 files detected")
    expect(message).toContain("  - src/api.ts")
    expect(message).toContain("  - src/types.ts")
    expect(message).toContain("  - lib/utils.ts")
    expect(message).toContain("fail-closed guard")
    expect(message).toContain("Remediation")
    expect(message).toContain(`git diff --stat origin/${branch}..HEAD`)
  })
})
