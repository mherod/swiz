import { describe, expect, test } from "bun:test"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { hookOutputSchema } from "../src/schemas.ts"
import posttooluseGitContext from "./posttooluse-git-context.ts"

const CLEAN_MAIN_STATUS = [
  "# branch.oid 0123456789abcdef",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +0 -0",
].join("\n")

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

  test("passively preserves authoritative trunk guidance after tool use", async () => {
    const git = new MockGitClient((args) => {
      if (args.includes("status") && args.includes("--porcelain=v2")) return CLEAN_MAIN_STATUS
      return { exitCode: 1 }
    })

    const output = await withGitClient(git, () =>
      posttooluseGitContext.run({
        cwd: "/repo",
        tool_name: "Read",
        tool_input: {},
        _repositoryCapability: repositoryCapability(true),
        _effectiveSettings: {
          collaborationMode: "solo",
          trunkMode: true,
          strictNoDirectMain: false,
        },
      })
    )
    const context = hookOutputSchema.parse(output).hookSpecificOutput?.additionalContext

    expect(context).toContain(
      "Project trunk mode is authoritative: keep work on the default branch and push directly when ready."
    )
    expect(context).toContain(
      "Do not create a feature branch or PR because of repository ownership or collaboration heuristics."
    )
  })
})
