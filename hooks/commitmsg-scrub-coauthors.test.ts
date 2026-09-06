import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { getGitClient } from "../src/git/client.ts"
import type { RepositoryCapability } from "../src/repository-capability.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateCommitMsgScrubCoauthors } from "./commitmsg-scrub-coauthors.ts"

const { create: makeTempDir } = useTempDir("swiz-commit-msg-security-")

function repositoryCapability(isRepo: boolean): RepositoryCapability {
  return {
    canonicalRoot: "/repo",
    repoKey: "commit-message-test",
    isRepo,
    repoSlug: isRepo ? "mherod/swiz" : null,
    hasGhCli: true,
    resolvedAt: Date.now(),
  }
}

async function evaluateMessage(content: string): Promise<{
  content: string
  systemMessage?: string
}> {
  const cwd = await makeTempDir()
  await getGitClient().run(["init", cwd])
  const messagePath = join(cwd, "COMMIT_EDITMSG")
  await Bun.write(messagePath, content)

  const result = await evaluateCommitMsgScrubCoauthors({
    cwd,
    commit_msg_file: messagePath,
  })

  return {
    content: await Bun.file(messagePath).text(),
    systemMessage: "systemMessage" in result ? result.systemMessage : undefined,
  }
}

describe("commitmsg-scrub-coauthors", () => {
  test("trusted non-repository enrichment avoids the fallback probe", async () => {
    const cwd = await makeTempDir()
    const messagePath = join(cwd, "COMMIT_EDITMSG")
    await Bun.write(
      messagePath,
      "feat: keep attribution\n\nCo-authored-by: Bot <bot@example.com>\n"
    )
    let fallbackCalls = 0

    const output = await evaluateCommitMsgScrubCoauthors(
      {
        cwd,
        commit_msg_file: messagePath,
        _repositoryCapability: repositoryCapability(false),
      },
      () => {
        fallbackCalls++
        return Promise.resolve(true)
      }
    )

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
    expect(await Bun.file(messagePath).text()).toContain("Co-authored-by")
  })

  test("scrubs Co-authored-by trailers", async () => {
    const result = await evaluateMessage(
      "feat: add feature\n\nCo-authored-by: Bot <bot@example.com>\n"
    )

    expect(result.content).toBe("feat: add feature\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs Claude Code generation signatures", async () => {
    const result = await evaluateMessage("fix: handle edge case\n\nGenerated with Claude Code\n")

    expect(result.content).toBe("fix: handle edge case\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("leaves ordinary commit messages unchanged", async () => {
    const result = await evaluateMessage("fix: handle edge case\n")

    expect(result.content).toBe("fix: handle edge case\n")
    expect(result.systemMessage).toBeUndefined()
  })

  test("scrubs session-attribution trailers", async () => {
    // A harness instructed to append `Claude-Session: <url>` produced a line matching
    // neither the co-author nor the generation pattern, so it reached the commit.
    const result = await evaluateMessage(
      "fix: handle edge case\n\nClaude-Session: https://claude.ai/code/session_01ABC\n"
    )

    expect(result.content).toBe("fix: handle edge case\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs a bare session URL line", async () => {
    // The trailer key alone is easy to rename, so the URL is matched on its own.
    const result = await evaluateMessage(
      "docs: update readme\n\nhttps://claude.ai/code/session_01ABC\n"
    )

    expect(result.content).toBe("docs: update readme\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs Assisted-By and Generated-With trailers", async () => {
    const result = await evaluateMessage(
      "chore: tidy\n\nAssisted-By: some-agent\nGenerated-With: some-tool\n"
    )

    expect(result.content).toBe("chore: tidy\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("keeps body lines that merely mention a session", async () => {
    // Control against an over-broad matcher: these are the false positives a bare
    // `Session:` alternative would have produced.
    const message =
      "fix(session): reuse warm session data\n\nSession handling now reuses the cached identity.\nSessions: 3 of 4 migrated.\n"
    const result = await evaluateMessage(message)

    expect(result.content).toBe(message)
    expect(result.systemMessage).toBeUndefined()
  })
})
