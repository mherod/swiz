import { describe, expect, test } from "bun:test"
import { gitBlobId, parseSkillLog } from "./skill-git-history.ts"

const ZERO = "0".repeat(40)
const blob = (n: number) => String(n).repeat(40).slice(0, 40)

/** One `git log --format=C%x09%H%x09%ct --raw --no-abbrev` commit block. */
function commit(sha: string, seconds: number, lines: [string, string][]): string {
  const raw = lines.map(([newBlob, path]) => `:100644 100644 ${ZERO} ${newBlob} M\t${path}`)
  return [`C\t${sha}\t${seconds}`, "", ...raw, ""].join("\n")
}

describe("parseSkillLog", () => {
  test("strips the repository prefix and lists versions newest first", () => {
    const output = [
      commit("c2", 200, [[blob(2), "skills/demo/SKILL.md"]]),
      commit("c1", 100, [
        [blob(1), "skills/demo/SKILL.md"],
        [blob(3), "skills/other/SKILL.md"],
      ]),
    ].join("")

    const { versions, removals } = parseSkillLog(output, "skills/demo/")

    expect(versions.get("SKILL.md")).toEqual([
      { sha: "c2", date: 200_000, blob: blob(2) },
      { sha: "c1", date: 100_000, blob: blob(1) },
    ])
    expect(versions.has("../other/SKILL.md")).toBe(false)
    expect(removals.size).toBe(0)
  })

  test("records a removal only when deletion is the newest event", () => {
    const output = [
      commit("c3", 300, [[ZERO, "gone.md"]]),
      commit("c2", 200, [[blob(2), "back.md"]]),
      commit("c1", 100, [
        [blob(1), "gone.md"],
        [ZERO, "back.md"],
      ]),
    ].join("")

    const { versions, removals } = parseSkillLog(output, "")

    expect(removals.get("gone.md")).toEqual({ sha: "c3", date: 300_000 })
    expect(removals.has("back.md")).toBe(false)
    expect(versions.get("gone.md")?.map((v) => v.sha)).toEqual(["c1"])
  })
})

describe("gitBlobId", () => {
  test("matches git hash-object for known content", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a"
    )
  })
})
