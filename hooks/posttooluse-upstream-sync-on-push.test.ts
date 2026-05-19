import { describe, expect, test } from "bun:test"
import {
  isDefaultBranchDrifted,
  isUpstreamMutatingCommand,
} from "./posttooluse-upstream-sync-on-push.ts"

describe("isUpstreamMutatingCommand", () => {
  test("detects git push", () => {
    expect(isUpstreamMutatingCommand("git push origin main")).toBe(true)
  })

  test("detects git pull", () => {
    expect(isUpstreamMutatingCommand("git pull")).toBe(true)
  })

  test("detects gh pr create / merge / close / edit / reopen / review", () => {
    expect(isUpstreamMutatingCommand("gh pr create --fill")).toBe(true)
    expect(isUpstreamMutatingCommand("gh pr merge 12 --squash")).toBe(true)
    expect(isUpstreamMutatingCommand("gh pr close 5")).toBe(true)
    expect(isUpstreamMutatingCommand("gh pr edit 8 --title 'x'")).toBe(true)
    expect(isUpstreamMutatingCommand("gh pr reopen 8")).toBe(true)
    expect(isUpstreamMutatingCommand("gh pr review 8 --approve")).toBe(true)
  })

  test("detects gh issue create / close / comment / edit / reopen", () => {
    expect(isUpstreamMutatingCommand("gh issue create -t x -b y")).toBe(true)
    expect(isUpstreamMutatingCommand("gh issue close 5")).toBe(true)
    expect(isUpstreamMutatingCommand("gh issue comment 5 -b hi")).toBe(true)
    expect(isUpstreamMutatingCommand("gh issue edit 5 --title z")).toBe(true)
    expect(isUpstreamMutatingCommand("gh issue reopen 5")).toBe(true)
  })

  test("detects gh api ... PATCH on issues/pulls", () => {
    expect(isUpstreamMutatingCommand("gh api repos/o/r/issues/5 -X PATCH -f title=hello")).toBe(
      true
    )
    expect(isUpstreamMutatingCommand("gh api repos/o/r/pulls/12 -X PATCH -f state=closed")).toBe(
      true
    )
  })

  test("ignores read-only and unrelated commands", () => {
    expect(isUpstreamMutatingCommand("git status")).toBe(false)
    expect(isUpstreamMutatingCommand("gh pr list")).toBe(false)
    expect(isUpstreamMutatingCommand("gh issue view 1")).toBe(false)
    expect(isUpstreamMutatingCommand("ls -la")).toBe(false)
    expect(isUpstreamMutatingCommand("")).toBe(false)
  })
})

describe("isDefaultBranchDrifted", () => {
  test("returns false when status is null", () => {
    expect(isDefaultBranchDrifted(null, "main")).toBe(false)
  })

  test("returns false when on a non-default branch even if drifted", () => {
    expect(isDefaultBranchDrifted({ branch: "feature/x", ahead: 3, behind: 0 }, "main")).toBe(false)
  })

  test("returns false on default branch with no drift", () => {
    expect(isDefaultBranchDrifted({ branch: "main", ahead: 0, behind: 0 }, "main")).toBe(false)
  })

  test("returns true on default branch when ahead > 0", () => {
    expect(isDefaultBranchDrifted({ branch: "main", ahead: 2, behind: 0 }, "main")).toBe(true)
  })

  test("returns true on default branch when behind > 0", () => {
    expect(isDefaultBranchDrifted({ branch: "main", ahead: 0, behind: 4 }, "main")).toBe(true)
  })

  test("returns true on default branch when both ahead and behind > 0", () => {
    expect(isDefaultBranchDrifted({ branch: "main", ahead: 1, behind: 1 }, "main")).toBe(true)
  })

  test("works with non-main default branch (e.g. dev, master)", () => {
    expect(isDefaultBranchDrifted({ branch: "dev", ahead: 1, behind: 0 }, "dev")).toBe(true)
    expect(isDefaultBranchDrifted({ branch: "master", ahead: 0, behind: 1 }, "master")).toBe(true)
    expect(isDefaultBranchDrifted({ branch: "main", ahead: 1, behind: 0 }, "dev")).toBe(false)
  })
})
