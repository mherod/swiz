import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { canonicalizePath } from "./project-identity.ts"
import {
  isGitRepoForHookPayload,
  type RepositoryCapability,
  resolveRepositoryCapability,
} from "./repository-capability.ts"
import { useTempDir } from "./utils/test-utils.ts"

const tempDirs = useTempDir("swiz-repository-capability-")

describe("resolveRepositoryCapability", () => {
  test("uses filesystem membership and performs one slug lookup for a repository", async () => {
    const root = await tempDirs.create()
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    let slugLookups = 0

    const capability = await resolveRepositoryCapability(join(root, "src"), async (cwd) => {
      slugLookups++
      expect(cwd).toBe(canonicalizePath(root))
      return "owner/repo"
    })

    expect(capability).toEqual({
      canonicalRoot: canonicalizePath(root),
      repoKey: expect.any(String),
      isGitRepo: true,
      repoSlug: "owner/repo",
    })
    expect(slugLookups).toBe(1)
  })

  test("does not query a slug for a non-repository directory", async () => {
    const root = await tempDirs.create()
    let slugLookups = 0

    const capability = await resolveRepositoryCapability(root, async () => {
      slugLookups++
      return "owner/repo"
    })

    expect(capability.isGitRepo).toBe(false)
    expect(capability.repoSlug).toBeNull()
    expect(slugLookups).toBe(0)
  })

  test("retains verified membership when origin resolution fails", async () => {
    const root = await tempDirs.create()
    await mkdir(join(root, ".git"), { recursive: true })

    const capability = await resolveRepositoryCapability(root, async () => {
      throw new Error("origin unavailable")
    })

    expect(capability.isGitRepo).toBe(true)
    expect(capability.repoSlug).toBeNull()
  })
})

const repositoryCapability = (isGitRepo: boolean): RepositoryCapability => ({
  canonicalRoot: "/repo",
  repoKey: "repo-key",
  isGitRepo,
  repoSlug: isGitRepo ? "owner/repo" : null,
})

describe("isGitRepoForHookPayload", () => {
  test.each([
    true,
    false,
  ])("reuses dispatcher-verified membership when isGitRepo=%s", async (expected) => {
    let fallbackCalls = 0
    const result = await isGitRepoForHookPayload(
      { _repositoryCapability: repositoryCapability(expected) },
      "/repo",
      async () => {
        fallbackCalls++
        return !expected
      }
    )

    expect(result).toBe(expected)
    expect(fallbackCalls).toBe(0)
  })

  test.each([
    ["absent", {}],
    ["malformed", { _repositoryCapability: { isGitRepo: true } }],
  ])("uses the injected canonical fallback when capability is %s", async (_name, input) => {
    const seenCwds: string[] = []
    const result = await isGitRepoForHookPayload(input, "malformed-cwd", async (cwd) => {
      seenCwds.push(cwd)
      return true
    })

    expect(result).toBe(true)
    expect(seenCwds).toEqual(["malformed-cwd"])
  })

  test("is the repository-membership boundary for every issue #753 gate", async () => {
    const hookFiles = [
      "pretooluse-pr-changes-branch-guard.ts",
      "pretooluse-task-governance.ts",
      "pretooluse-sandboxed-edits.ts",
      "pretooluse-repeated-lint-test.ts",
      "pretooluse-pr-comment-read-gate.ts",
      "pretooluse-no-phantom-task-completion.ts",
      "pretooluse-branch-intent-gate.ts",
      "pretooluse-pr-head-checkout-gate.ts",
      "pretooluse-update-memory-enforcement.ts",
      "pretooluse-issue-workflow-gate.ts",
      "pretooluse-block-preexisting-dismissals.ts",
      "pretooluse-dirty-worktree-gate.ts",
      "pretooluse-trunk-mode-branch-gate.ts",
    ]

    for (const hookFile of hookFiles) {
      const source = await Bun.file(join(process.cwd(), "hooks", hookFile)).text()
      expect(source, hookFile).toContain("isGitRepoForHookPayload(")
    }
  })
})
