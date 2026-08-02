import { describe, expect, test } from "bun:test"
import {
  evaluateWorktreePreservation,
  type WorktreePreservationRuntime,
} from "./worktree-preservation.ts"

function runtimeWith(responses: Record<string, string>): WorktreePreservationRuntime {
  return {
    async git(args) {
      return responses[args.join(" ")] ?? ""
    },
  }
}

const linkedWorktree = {
  "rev-parse --absolute-git-dir": "/repo/.git/worktrees/feature",
  "rev-parse --path-format=absolute --git-common-dir": "/repo/.git",
}

const baseInput = {
  cwd: "/repo-feature",
  branch: "feature/preserve",
  defaultBranch: "main",
  trunkMode: false,
}

describe("evaluateWorktreePreservation", () => {
  test("preserves a conflicting linked worktree through a PR", async () => {
    const result = await evaluateWorktreePreservation(
      baseInput,
      runtimeWith({
        ...linkedWorktree,
        "rev-parse --verify main": "main-sha",
        "merge-base HEAD main": "base-sha",
        "merge-tree base-sha HEAD main": "+<<<<<<< .our\n+=======\n+>>>>>>> .their",
      })
    )

    expect(result).toEqual({
      preserveViaPr: true,
      branch: "feature/preserve",
      defaultBranch: "main",
      defaultRef: "main",
      conflictCount: 1,
    })
  })

  test("uses an authoritative PR conflict when the default ref is unavailable", async () => {
    const result = await evaluateWorktreePreservation(
      { ...baseInput, conflictsWithDefault: true },
      runtimeWith(linkedWorktree)
    )

    expect(result).toMatchObject({ preserveViaPr: true, defaultRef: "main" })
  })

  test("keeps normal policy for a cleanly integrating linked worktree", async () => {
    const result = await evaluateWorktreePreservation(
      baseInput,
      runtimeWith({
        ...linkedWorktree,
        "rev-parse --verify origin/main": "main-sha",
        "merge-base HEAD origin/main": "base-sha",
        "merge-tree base-sha HEAD origin/main": "merged cleanly",
      })
    )

    expect(result).toMatchObject({ preserveViaPr: false, reason: "no-conflicts" })
  })

  test("keeps normal policy in the primary working tree", async () => {
    const result = await evaluateWorktreePreservation(
      baseInput,
      runtimeWith({
        "rev-parse --absolute-git-dir": "/repo/.git",
        "rev-parse --path-format=absolute --git-common-dir": "/repo/.git",
      })
    )

    expect(result).toMatchObject({ preserveViaPr: false, reason: "not-linked-worktree" })
  })

  test("keeps normal policy when trunk mode is enabled", async () => {
    const result = await evaluateWorktreePreservation(
      { ...baseInput, trunkMode: true, conflictsWithDefault: true },
      runtimeWith(linkedWorktree)
    )

    expect(result).toMatchObject({ preserveViaPr: false, reason: "trunk-mode" })
  })

  test("keeps normal policy on the default branch", async () => {
    const result = await evaluateWorktreePreservation(
      { ...baseInput, branch: "main", conflictsWithDefault: true },
      runtimeWith(linkedWorktree)
    )

    expect(result).toMatchObject({ preserveViaPr: false, reason: "default-branch" })
  })
})
