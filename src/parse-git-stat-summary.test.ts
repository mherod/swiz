import { describe, expect, it } from "bun:test"
import { parseGitStatSummary } from "../hooks/hook-utils.ts"

describe("parseGitStatSummary", () => {
  it("parses both insertions and deletions", () => {
    const input = ` README.md          |   5 +-
 hooks/scope-gate.ts | 156 +++++++++++++++++++++
 src/manifest.ts     |   1 +
 3 files changed, 160 insertions(+), 2 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 3,
      insertions: 160,
      deletions: 2,
    })
  })

  it("parses insertions only (no deletions)", () => {
    const input = ` src/api/users.ts  |  15 +++++++++++++++
 src/types/user.ts |   6 ++++++
 2 files changed, 21 insertions(+)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 2,
      insertions: 21,
      deletions: 0,
    })
  })

  it("parses deletions only (no insertions)", () => {
    const input = ` src/deprecated.ts | 45 -----------------------------------------
 1 file changed, 45 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 45,
    })
  })

  it("parses rename only (no content change)", () => {
    // git outputs just "N file(s) changed" with no insertions/deletions
    const input = ` src/{old.ts => new.ts} | 0
 1 file changed`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })

  it("parses single file singular form", () => {
    const input = ` hooks/gate.ts | 14 ++++++++------
 1 file changed, 8 insertions(+), 6 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 8,
      deletions: 6,
    })
  })

  it("parses single insertion singular form", () => {
    const input = ` config.json | 1 +
 1 file changed, 1 insertion(+)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    })
  })

  it("parses single deletion singular form", () => {
    const input = ` config.json | 1 -
 1 file changed, 1 deletion(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 1,
    })
  })

  it("parses binary file with zero counts", () => {
    const input = ` image.png | Bin 0 -> 12345 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for empty string", () => {
    expect(parseGitStatSummary("")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for whitespace-only string", () => {
    expect(parseGitStatSummary("  \n  \n  ")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("returns zeros for string with no summary line", () => {
    // Just file lines, no summary — shouldn't happen in practice but must not crash
    expect(parseGitStatSummary(" hooks/gate.ts | 14 ++++++++------")).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it("handles large numbers", () => {
    const input = ` 15 files changed, 2847 insertions(+), 1203 deletions(-)`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 15,
      insertions: 2847,
      deletions: 1203,
    })
  })

  it("handles binary-only change (no summary with counts)", () => {
    // Some binary-only changes show "Bin X -> Y bytes" without insertions/deletions line
    const input = ` image.png | Bin 1234 -> 5678 bytes
 1 file changed`

    expect(parseGitStatSummary(input)).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    })
  })
})
