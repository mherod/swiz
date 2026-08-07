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
