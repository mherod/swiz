import { describe, expect, test } from "bun:test"
import { parseGitStatusV2Output } from "./git-utils.ts"

// ── parseGitStatusV2Output — upstreamGone detection ──────────────────────────
// These tests verify that a "gone" upstream (branch.upstream present but
// branch.ab absent) is correctly detected and does not get confused with
// a healthy upstream that happens to be at zero divergence.

describe("parseGitStatusV2Output — upstreamGone", () => {
  test("upstreamGone=true when branch.upstream present but branch.ab absent", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/my-feature",
      "# branch.upstream origin/feat/my-feature",
      // branch.ab is intentionally absent — upstream is gone
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(true)
    expect(result!.upstream).toBe("origin/feat/my-feature")
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
    expect(result!.branch).toBe("feat/my-feature")
  })

  test("upstreamGone=false when both branch.upstream and branch.ab are present", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBe("origin/main")
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
  })

  test("upstreamGone=false when upstream has diverged commits (+3 -1)", () => {
    const out = [
      "# branch.oid def456",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +3 -1",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.ahead).toBe(3)
    expect(result!.behind).toBe(1)
  })

  test("upstreamGone=false when no upstream tracking branch at all", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head local-only",
      // no branch.upstream, no branch.ab
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBeNull()
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
  })

  test("upstreamGone=true does not affect file change counts", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/gone",
      "# branch.upstream origin/feat/gone",
      // no branch.ab — upstream gone
      "1 .M N... 100644 100644 100644 hash1 hash2 src/foo.ts",
      "? untracked.txt",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(true)
    expect(result!.total).toBe(2)
    expect(result!.modified).toBe(1)
    expect(result!.untracked).toBe(1)
  })

  test("detached HEAD with no upstream yields upstreamGone=false", () => {
    const out = ["# branch.oid abc123", "# branch.head (detached)"].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.branch).toBe("(detached)")
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBeNull()
  })
})

describe("parseGitStatusV2Output — returns null for empty input", () => {
  test("returns null for empty string", () => {
    expect(parseGitStatusV2Output("")).toBeNull()
  })
})
