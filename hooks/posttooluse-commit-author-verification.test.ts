import { describe, expect, test } from "bun:test"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { evaluatePosttooluseCommitAuthorVerification } from "./posttooluse-commit-author-verification.ts"

interface GitIdentityState {
  configName?: string
  configEmail?: string
  authorName?: string
  authorEmail?: string
  committerName?: string
  committerEmail?: string
}

function createGitMock(state: GitIdentityState = {}): MockGitClient {
  return new MockGitClient((args) => {
    const command = args.join("\0")
    if (command === "rev-parse\0--git-dir") return ".git"
    if (command === "config\0--get\0user.name") return state.configName ?? "Real User"
    if (command === "config\0--get\0user.email") return state.configEmail ?? "real@company.dev"
    if (command === "log\0-1\0--format=%an%x00%ae%x00%cn%x00%ce\0HEAD") {
      return [
        state.authorName ?? "Real User",
        state.authorEmail ?? "real@company.dev",
        state.committerName ?? "Real User",
        state.committerEmail ?? "real@company.dev",
      ].join("\0")
    }
    return { exitCode: 1 }
  })
}

async function runHook(state: GitIdentityState, command = 'git commit -m "test"') {
  return await withGitClient(createGitMock(state), async () => {
    const result = await evaluatePosttooluseCommitAuthorVerification({
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/repo",
    })
    return result
  })
}

describe("posttooluse-commit-author-verification", () => {
  test("does nothing for non-commit commands", async () => {
    const result = await runHook({}, "git status")
    expect(result).toEqual({})
  })

  test("blocks placeholder git config identity even when HEAD matches it", async () => {
    const result = await runHook({
      configName: "Test",
      configEmail: "test@test.com",
      authorName: "Test",
      authorEmail: "test@test.com",
      committerName: "Test",
      committerEmail: "test@test.com",
    })

    expect((result as { decision?: string }).decision).toBe("block")
    expect((result as { reason?: string }).reason).toContain(
      "git config user.name is a placeholder"
    )
    expect((result as { reason?: string }).reason).toContain(
      "git config user.email is a placeholder"
    )
  })

  test("blocks HEAD author mismatch against git config", async () => {
    const result = await runHook({
      configName: "Real User",
      configEmail: "real@company.dev",
      authorName: "Test",
      authorEmail: "test@test.com",
      committerName: "Real User",
      committerEmail: "real@company.dev",
    })

    expect((result as { decision?: string }).decision).toBe("block")
    expect((result as { reason?: string }).reason).toContain(
      "HEAD author does not match git config user.name/user.email"
    )
  })

  test("allows matching real config and HEAD identities", async () => {
    const result = await runHook({})
    expect(result).toEqual({})
  })

  test("skips failed commit responses", async () => {
    const result = await withGitClient(createGitMock({ configName: "Test" }), async () => {
      const output = await evaluatePosttooluseCommitAuthorVerification({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        tool_response: { exit_code: 1 },
        cwd: "/repo",
      })
      return output
    })
    expect(result).toEqual({})
  })
})
