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
})
