import { describe, expect, test } from "bun:test"
import { extractPrNumber, isPullRequestMergeCommand } from "./utils/git-utils.ts"

describe("isPullRequestMergeCommand", () => {
  const mergeCommands = [
    "gh pr merge 42 --squash",
    "command gh pr merge 42 --auto --squash",
    "gh api repos/octocat/Hello-World/pulls/42/merge --method PUT",
    "gh api --method=PUT /repos/octocat/Hello-World/pulls/42/merge",
    "gh api -X PUT repos/octocat/Hello-World/pulls/42/merge",
    "curl -L -X PUT https://api.github.com/repos/octocat/Hello-World/pulls/42/merge",
    String.raw`curl -L \
      -X PUT \
      https://github.example.com/api/v3/repos/octocat/Hello-World/pulls/42/merge`,
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { pullRequest { merged } } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_1\"}) { pullRequest { id } } }'",
    "gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: \"PR_1\"}) { mergeQueueEntry { id } } }'",
    'curl https://api.github.com/graphql -d \'{"query":"mutation { mergePullRequest(input: {pullRequestId: \\"PR_1\\"}) { pullRequest { merged } } }"}\'',
  ]

  for (const command of mergeCommands) {
    test(`matches ${command}`, () => {
      expect(isPullRequestMergeCommand(command)).toBe(true)
    })
  }

  const nonMergeCommands = [
    "gh pr view 42",
    "gh api repos/octocat/Hello-World/pulls/42/merge",
    "gh api -X GET repos/octocat/Hello-World/pulls/42/merge",
    "curl https://api.github.com/repos/octocat/Hello-World/pulls/42/merge",
    "gh api -X PUT repos/octocat/Hello-World/pulls/42/update-branch",
    'gh api graphql -f query=\'query { repository(owner: "octocat", name: "Hello-World") { id } }\'',
    "gh api graphql -f query='mutation { updatePullRequestBranch(input: {pullRequestId: \"PR_1\"}) { pullRequest { id } } }'",
    "echo 'gh api -X PUT repos/octocat/Hello-World/pulls/42/merge'",
    "gh issue create --body 'use mergePullRequest when this is ready'",
  ]

  for (const command of nonMergeCommands) {
    test(`does not match ${command}`, () => {
      expect(isPullRequestMergeCommand(command)).toBe(false)
    })
  }
})

describe("extractPrNumber", () => {
  test("extracts a number from gh pr merge", () => {
    expect(extractPrNumber("gh pr merge 42 --squash")).toBe("42")
  })

  test("extracts a number from the REST merge endpoint", () => {
    expect(extractPrNumber("gh api --method PUT repos/octocat/Hello-World/pulls/1347/merge")).toBe(
      "1347"
    )
  })

  test("returns null for a GraphQL merge mutation without a PR number", () => {
    expect(
      extractPrNumber(
        "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: $id}) { pullRequest { id } } }'"
      )
    ).toBeNull()
  })
})
