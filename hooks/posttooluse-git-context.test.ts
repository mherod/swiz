import { describe, expect, test } from "bun:test"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import posttooluseGitContext from "./posttooluse-git-context.ts"

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "posttooluse-git-context-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

describe("posttooluse-git-context repository capability", () => {
  test("trusts enriched non-repository membership without spawning git", async () => {
    const git = new MockGitClient()
    const output = await withGitClient(git, () =>
      posttooluseGitContext.run({
        cwd: "/repo",
        tool_name: "Read",
        tool_input: {},
        _repositoryCapability: repositoryCapability(false),
      })
    )

    expect(output).toEqual({})
    expect(git.calls).toHaveLength(0)
  })

  test("retains the standalone repository-membership fallback", async () => {
    const git = new MockGitClient()
    const output = await withGitClient(git, () =>
      posttooluseGitContext.run({ cwd: "/repo", tool_name: "Read", tool_input: {} })
    )

    expect(output).toEqual({})
    expect(git.calls.map((call) => call.args)).toContainEqual(["rev-parse", "--git-dir"])
  })
})
