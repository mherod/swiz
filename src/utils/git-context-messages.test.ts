import { describe, expect, test } from "bun:test"
import {
  buildBranchStateSystemMessage,
  buildGitContextLine,
  type GitContextMessageStatus,
} from "./git-context-messages"

function cleanMainStatus(): GitContextMessageStatus {
  return {
    branch: "main",
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    lines: [],
    ahead: 1,
    behind: 0,
    upstream: "origin/main",
    upstreamGone: false,
  }
}

describe("buildGitContextLine trunk policy", () => {
  test("states that explicit trunk mode outranks collaboration heuristics", () => {
    const context = buildGitContextLine(cleanMainStatus(), {
      collaborationMode: "solo",
      trunkMode: true,
      strictNoDirectMain: false,
      defaultBranch: "main",
    })

    expect(context).toContain("Project trunk mode is authoritative")
    expect(context).toContain("Do not create a feature branch or PR")
    expect(context).toContain("repository ownership or collaboration heuristics")
  })

  test("keeps trunk mode authoritative when collaboration mode says team", () => {
    const context = buildBranchStateSystemMessage(cleanMainStatus(), {
      collaborationMode: "team",
      trunkMode: true,
      strictNoDirectMain: false,
    })

    expect(context).toContain("push this commit to main with /push")
    expect(context).not.toContain("open a PR")
  })

  test("surfaces conflicting branch settings without choosing a delivery path", () => {
    const options = {
      collaborationMode: "team",
      trunkMode: true,
      strictNoDirectMain: true,
      defaultBranch: "main",
    }

    const contextLine = buildGitContextLine(cleanMainStatus(), options)
    const systemMessage = buildBranchStateSystemMessage(cleanMainStatus(), options)

    for (const context of [contextLine, systemMessage]) {
      expect(context).toContain("Trunk mode and strict no-direct-main are both enabled")
      expect(context).toContain("resolve that workflow conflict before pushing")
      expect(context).not.toContain("push this commit")
      expect(context).not.toContain("open a PR")
    }
  })
})
