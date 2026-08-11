import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { getGitClient, withGitClient } from "../git/client.ts"
import { MockGitClient } from "../git/mock-client.ts"
import { makeTempGitRepo, runGit, useTempDir } from "../utils/test-utils.ts"
import { retireStashByOid, stashCommand } from "./stash.ts"

const OID = "a".repeat(40)
const OTHER_OID = "b".repeat(40)
const tmp = useTempDir("swiz-stash-retire-")

function sequenceGit(
  results: Array<string | { stdout?: string; stderr?: string; exitCode?: number }>
): MockGitClient {
  let index = 0
  return new MockGitClient(() => results[index++] ?? { stderr: "unexpected git call", exitCode: 1 })
}

describe("retireStashByOid", () => {
  test("requires a full SHA-1 or SHA-256 object ID before running Git", async () => {
    const git = new MockGitClient()

    await expect(withGitClient(git, () => retireStashByOid("abc", "/repo"))).rejects.toThrow(
      "full 40- or 64-character"
    )
    expect(git.calls).toHaveLength(0)
  })

  test("refuses an OID that is absent from the current stash inventory", async () => {
    const git = sequenceGit([""])

    await expect(withGitClient(git, () => retireStashByOid(OID, "/repo"))).rejects.toThrow(
      "not present"
    )
    expect(git.calls).toHaveLength(1)
  })

  test("refuses duplicate selectors for the same OID", async () => {
    const git = sequenceGit([`stash@{0} ${OID}\nstash@{2} ${OID}\n`])

    await expect(withGitClient(git, () => retireStashByOid(OID, "/repo"))).rejects.toThrow(
      "multiple selectors"
    )
    expect(git.calls).toHaveLength(1)
  })

  test("refuses when the resolved selector moved before deletion", async () => {
    const git = sequenceGit([`stash@{2} ${OID}\n`, `${OTHER_OID}\n`])

    await expect(withGitClient(git, () => retireStashByOid(OID, "/repo"))).rejects.toThrow(
      "changed before retirement"
    )
    expect(git.calls.map((call) => call.args[0])).toEqual(["stash", "rev-parse"])
  })

  test("drops one verified selector and proves the OID is absent", async () => {
    const git = sequenceGit([`stash@{2} ${OID}\n`, `${OID}\n`, "Dropped\n", ""])

    const receipt = await withGitClient(git, () => retireStashByOid(OID, "/repo"))

    expect(receipt).toEqual({ oid: OID, selector: "stash@{2}" })
    expect(git.calls.map((call) => call.args)).toEqual([
      ["stash", "list", "--format=%gd %H"],
      ["rev-parse", "--verify", "stash@{2}"],
      ["stash", "drop", "stash@{2}"],
      ["stash", "list", "--format=%H"],
    ])
    expect(git.calls.every((call) => call.options.cwd === "/repo")).toBe(true)
  })

  test("reports an incomplete retirement when the OID remains", async () => {
    const git = sequenceGit([`stash@{0} ${OID}\n`, `${OID}\n`, "Dropped\n", `${OID}\n`])

    await expect(withGitClient(git, () => retireStashByOid(OID, "/repo"))).rejects.toThrow(
      "still present"
    )
  })

  test("leaves the worktree unchanged in a real disposable repository", async () => {
    const repo = await makeTempGitRepo(tmp)
    const tracked = join(repo, "tracked.txt")
    await Bun.write(tracked, "committed\n")
    await runGit(repo, ["add", "tracked.txt"])
    await runGit(repo, ["commit", "-m", "add tracked file"])
    await Bun.write(tracked, "stashed\n")
    await runGit(repo, ["stash", "push", "-m", "retirement fixture"])
    const oid = await runGit(repo, ["rev-parse", "refs/stash"])
    const before = await runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"])

    await retireStashByOid(oid, repo)

    expect(await runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before)
    expect(await runGit(repo, ["stash", "list", "--format=%H"])).not.toContain(oid)
  })
})

describe("stashCommand", () => {
  test("rejects missing and unknown subcommands", async () => {
    await expect(stashCommand.run([])).rejects.toThrow("Usage: swiz stash retire")
    await expect(stashCommand.run(["drop", OID])).rejects.toThrow("Unknown subcommand")
  })

  test("prints an immutable retirement receipt", async () => {
    const git = sequenceGit([`stash@{0} ${OID}\n`, `${OID}\n`, "Dropped\n", ""])
    const writes: string[] = []

    await withGitClient(git, () =>
      stashCommand.run(["retire", OID], {
        cwd: "/repo",
        write: (value) => writes.push(value),
      })
    )

    expect(writes.join("\n")).toContain(`Retired stash stash@{0} at ${OID}`)
  })

  test("uses the current Git client for command execution", async () => {
    const git = sequenceGit([`stash@{0} ${OID}\n`, `${OID}\n`, "Dropped\n", ""])
    await withGitClient(git, async () => {
      expect(getGitClient()).toBe(git)
      await stashCommand.run(["retire", OID], { cwd: "/repo", write: () => {} })
    })
  })
})
