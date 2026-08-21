import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildLintStagedCommand,
  evaluateStopLintStaged,
  shouldSkipForPeerOwnership,
} from "./stop-lint-staged.ts"

describe("buildLintStagedCommand (issue #839)", () => {
  test("script variant runs through the package manager with --no-stash", () => {
    expect(buildLintStagedCommand("bun", true)).toEqual([
      "bun",
      "run",
      "lint-staged",
      "--",
      "--no-stash",
    ])
    expect(buildLintStagedCommand("pnpm", true)).toEqual([
      "pnpm",
      "run",
      "lint-staged",
      "--",
      "--no-stash",
    ])
  })

  test("dependency variant runs npx with --no-stash", () => {
    expect(buildLintStagedCommand("npm", false)).toEqual([
      "npx",
      "--yes",
      "lint-staged",
      "--no-stash",
    ])
  })
})

describe("shouldSkipForPeerOwnership (issue #839)", () => {
  test("skips when another live session owns a dirty file", () => {
    expect(
      shouldSkipForPeerOwnership({
        editedByUs: ["mine.ts"],
        editedByOthers: ["theirs.ts"],
        unattributed: [],
      })
    ).toBe(true)
  })

  test("runs for own and unattributed files — the solo case stays gated", () => {
    expect(
      shouldSkipForPeerOwnership({
        editedByUs: ["mine.ts"],
        editedByOthers: [],
        unattributed: ["unknown.ts"],
      })
    ).toBe(false)
  })
})

describe("evaluateStopLintStaged", () => {
  test("no-ops in a project without lint-staged configuration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-stop-lint-staged-"))
    const result = await evaluateStopLintStaged({
      session_id: "test-session",
      transcript_path: "/tmp/none.jsonl",
      hook_event_name: "Stop",
      cwd,
    })
    expect(result).toEqual({})
  })
})
