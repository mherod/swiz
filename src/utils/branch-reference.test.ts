import { describe, expect, test } from "bun:test"
import {
  branchReferenceAliases,
  branchReferencesAlign,
  isValidBranchReference,
  normalizeBranchReference,
} from "./branch-reference.ts"

describe("branch-reference", () => {
  test("normalizes sentence-ending periods that Git rejects", () => {
    expect(normalizeBranchReference("main.")).toBe("main")
    expect(normalizeBranchReference("feat/issue-42.")).toBe("feat/issue-42")
  })

  test("keeps meaningful dots inside valid branch names", () => {
    expect(normalizeBranchReference("release/1.2")).toBe("release/1.2")
    expect(normalizeBranchReference("v1.2.3")).toBe("v1.2.3")
  })

  test("unwraps common transcript markup", () => {
    expect(normalizeBranchReference("`main`.")).toBe("main")
    expect(normalizeBranchReference('"feat/issue-42"')).toBe("feat/issue-42")
  })

  test("rejects invalid or ambiguous branch references", () => {
    expect(normalizeBranchReference("main..topic")).toBeNull()
    expect(normalizeBranchReference(".hidden")).toBeNull()
    expect(normalizeBranchReference("feature.lock")).toBeNull()
  })

  test("matches local branches to common remote reference forms", () => {
    expect(branchReferencesAlign("main", "origin/main")).toBe(true)
    expect(branchReferencesAlign("feat/pr-1", "refs/remotes/origin/feat/pr-1")).toBe(true)
    expect(branchReferencesAlign("feat/pr-1", "feature/pr-1")).toBe(false)
  })

  test("returns checkout aliases for remote references", () => {
    expect(branchReferenceAliases("origin/feat/pr-1")).toEqual(["origin/feat/pr-1", "feat/pr-1"])
    expect(branchReferenceAliases("feat/pr-1")).toEqual(["feat/pr-1"])
  })

  test("implements the ref-name constraints used by normalization", () => {
    expect(isValidBranchReference("main")).toBe(true)
    expect(isValidBranchReference("main.")).toBe(false)
    expect(isValidBranchReference("main topic")).toBe(false)
  })
})
