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

    expect(result.content).toBe("feat: add feature\n\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs Claude Code generation signatures", async () => {
    const result = await evaluateMessage("fix: handle edge case\n\nGenerated with Claude Code\n")

    expect(result.content).toBe("fix: handle edge case\n\n")
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

    expect(result.content).toBe("fix: handle edge case\n\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs a bare session URL line", async () => {
    // The trailer key alone is easy to rename, so the URL is matched on its own.
    const result = await evaluateMessage(
      "docs: update readme\n\nhttps://claude.ai/code/session_01ABC\n"
    )

    expect(result.content).toBe("docs: update readme\n\n")
    expect(result.systemMessage).toContain("attribution")
  })

  test("scrubs Assisted-By and Generated-With trailers", async () => {
    const result = await evaluateMessage(
      "chore: tidy\n\nAssisted-By: some-agent\nGenerated-With: some-tool\n"
    )

    expect(result.content).toBe("chore: tidy\n\n")
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

  for (const newline of ["\n", "\r\n"]) {
    for (const ending of ["", newline]) {
      test(`preserves template whitespace with ${JSON.stringify(newline)} and ending ${JSON.stringify(ending)}`, async () => {
        const before = ["", "", "fix: preserve template  ", "", "Body paragraph.\t", ""].join(
          newline
        )
        const after = ["", "Second paragraph.  ", "", ""].join(newline) + ending
        const result = await evaluateMessage(
          `${before}Co-authored-by: Bot <bot@example.com>${newline}${after}`
        )

        expect(result.content).toBe(before + after)
        expect(result.systemMessage).toContain("attribution")
      })

      test(`preserves the scissors suffix with ${JSON.stringify(newline)} and ending ${JSON.stringify(ending)}`, async () => {
        const message = `${newline}fix: preserve verbose diff${newline}${newline}`
        const suffix =
          [
            "# ------------------------ >8 ------------------------",
            "# Everything below this line is discarded by Git.",
            "diff --git a/example b/example",
            "+Generated with Claude Code",
            "Co-authored-by: Diff fixture <diff@example.com>",
            "Claude-Session: https://claude.ai/code/session_fixture",
            "  ",
          ].join(newline) + ending
        const result = await evaluateMessage(
          `${message}Generated-With: some-tool${newline}${suffix}`
        )

        expect(result.content).toBe(message + suffix)
        expect(result.systemMessage).toContain("attribution")
      })
    }
  }

  test("leaves attribution below scissors unchanged without reporting a scrub", async () => {
    const message = "fix: keep diff\n\n# ---- >8 ----\nGenerated with Claude Code\n\n"
    const result = await evaluateMessage(message)

    expect(result.content).toBe(message)
    expect(result.systemMessage).toBeUndefined()
  })

  test("preserves a message without a final newline", async () => {
    const result = await evaluateMessage(
      "fix: keep ending\r\nAssisted-By: some-agent\r\nFinal body line  "
    )

    expect(result.content).toBe("fix: keep ending\r\nFinal body line  ")
    expect(result.systemMessage).toContain("attribution")
  })

  test("preserves mixed line endings outside removed attribution lines", async () => {
    const result = await evaluateMessage(
      "fix: preserve endings\r\n\nGenerated-With: some-tool\r\nBody\n\r\n"
    )

    expect(result.content).toBe("fix: preserve endings\r\n\nBody\n\r\n")
  })

  test("removes a prohibited-only message without adding a newline", async () => {
    const result = await evaluateMessage("Claude-Session: https://claude.ai/code/session_fixture")

    expect(result.content).toBe("")
    expect(result.systemMessage).toContain("attribution")
  })

  test("does not treat an inline scissors example as a cutoff", async () => {
    const body = "fix: explain # ---- >8 ---- in prose\n"
    const result = await evaluateMessage(`${body}Generated-With: some-tool\n`)

    expect(result.content).toBe(body)
    expect(result.systemMessage).toContain("attribution")
  })
})
