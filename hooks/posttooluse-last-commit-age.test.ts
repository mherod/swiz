import { describe, expect, test } from "bun:test"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { hookOutputSchema } from "../src/schemas.ts"
import {
  evaluatePosttooluseLastCommitAge,
  formatLastCommitAgeContext,
} from "./posttooluse-last-commit-age.ts"

const NOW_MS = Date.parse("2026-08-09T12:00:00.000Z")

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "posttooluse-last-commit-age-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: NOW_MS,
  }
}

describe("posttooluse-last-commit-age", () => {
  test("emits the current HEAD commit age as PostToolUse context", async () => {
    const commitTimestampSeconds = (NOW_MS - (2 * 60 + 15) * 60_000) / 1000
    const git = new MockGitClient((args) =>
      args.join(" ") === "log -1 --format=%ct" ? String(commitTimestampSeconds) : { exitCode: 1 }
    )

    const output = await withGitClient(git, () =>
      evaluatePosttooluseLastCommitAge(
        {
          cwd: "/repo",
          tool_name: "Read",
          tool_input: {},
          _repositoryCapability: repositoryCapability(true),
        },
        NOW_MS
      )
    )

    const parsed = hookOutputSchema.parse(output)
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput?.additionalContext).toBe("Last commit was 2h 15m ago.")
    expect(git.calls.map((call) => call.args)).toEqual([["log", "-1", "--format=%ct"]])
  })

  test("skips non-repositories without spawning git", async () => {
    const git = new MockGitClient()
    const output = await withGitClient(git, () =>
      evaluatePosttooluseLastCommitAge({
        cwd: "/repo",
        tool_name: "Read",
        tool_input: {},
        _repositoryCapability: repositoryCapability(false),
      })
    )

    expect(output).toEqual({})
    expect(git.calls).toHaveLength(0)
  })

  test("fails open when HEAD has no readable commit", async () => {
    const git = new MockGitClient()
    const output = await withGitClient(git, () =>
      evaluatePosttooluseLastCommitAge({
        cwd: "/repo",
        tool_name: "Read",
        tool_input: {},
        _repositoryCapability: repositoryCapability(true),
      })
    )

    expect(output).toEqual({})
  })

  test("rejects invalid ages", () => {
    expect(formatLastCommitAgeContext(-1)).toBeNull()
    expect(formatLastCommitAgeContext(Number.NaN)).toBeNull()
  })
})
