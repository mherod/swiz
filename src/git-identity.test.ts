import { describe, expect, test } from "bun:test"
import { withGitClient } from "./git/client.ts"
import { MockGitClient } from "./git/mock-client.ts"
import { checkGitIdentity } from "./git-identity.ts"
import type { RepositoryCapability } from "./repository-capability.ts"

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "git-identity-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("git-identity repository capability", () => {
  test("trusts enriched non-repository membership without fallback", async () => {
    let fallbackCalls = 0
    const result = await checkGitIdentity(
      "/repo",
      { _repositoryCapability: repositoryCapability(false) },
      () => {
        fallbackCalls++
        return Promise.resolve(true)
      }
    )

    expect(result).toEqual({
      ok: true,
      isGitRepo: false,
      identity: { name: "", email: "" },
      problems: [],
    })
    expect(fallbackCalls).toBe(0)
  })

  test("retains the standalone non-repository fallback", async () => {
    let fallbackCalls = 0
    const result = await checkGitIdentity("/repo", {}, () => {
      fallbackCalls++
      return Promise.resolve(false)
    })

    expect(result.isGitRepo).toBe(false)
    expect(fallbackCalls).toBe(1)
  })

  test("reads identity without probing membership when enrichment says repository", async () => {
    const git = new MockGitClient((args) => {
      const command = args.join("\0")
      if (command === "config\0--get\0user.name") return "Matthew Herod"
      if (command === "config\0--get\0user.email") return "matthew@openai.com"
      return { exitCode: 1 }
    })

    const result = await withGitClient(git, () =>
      checkGitIdentity("/repo", { _repositoryCapability: repositoryCapability(true) }, () =>
        Promise.reject(new Error("fallback should not run"))
      )
    )

    expect(result.ok).toBe(true)
    expect(git.calls.map((call) => call.args)).not.toContainEqual(["rev-parse", "--git-dir"])
  })
})

describe("git-identity unreadable config", () => {
  test("reports missing identity when git answers that the keys are unset", async () => {
    const git = new MockGitClient(() => ({ exitCode: 1 }))

    const result = await withGitClient(git, () =>
      checkGitIdentity("/repo", { _repositoryCapability: repositoryCapability(true) })
    )

    expect(result.readable).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      "git config user.name is missing",
      "git config user.email is missing",
    ])
  })

  test("stays inconclusive when git cannot run at all", async () => {
    // Exit 128 is what an unusable or non-repository cwd produces — the daemon-context failure
    // that previously surfaced as "user.name is missing" and blocked commits.
    const git = new MockGitClient(() => ({ exitCode: 128 }))

    const result = await withGitClient(git, () =>
      checkGitIdentity("/repo", { _repositoryCapability: repositoryCapability(true) })
    )

    expect(result.readable).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  test("stays inconclusive when the git invocation throws", async () => {
    const git = new MockGitClient(() => {
      throw new Error("spawn failed")
    })

    const result = await withGitClient(git, () =>
      checkGitIdentity("/repo", { _repositoryCapability: repositoryCapability(true) })
    )

    expect(result.readable).toBe(false)
    expect(result.ok).toBe(true)
  })

  test("stays inconclusive when only one of the two lookups fails", async () => {
    const git = new MockGitClient((args) => {
      if (args.join("\0") === "config\0--get\0user.name") return "Matthew Herod"
      return { exitCode: 128 }
    })

    const result = await withGitClient(git, () =>
      checkGitIdentity("/repo", { _repositoryCapability: repositoryCapability(true) })
    )

    expect(result.readable).toBe(false)
    expect(result.ok).toBe(true)
  })
})
