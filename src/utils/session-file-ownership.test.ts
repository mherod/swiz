import { describe, expect, test } from "bun:test"
import {
  appendSessionFileOwnershipContext,
  classifySessionFileOwnership,
} from "./session-file-ownership.ts"

describe("session file ownership", () => {
  test("requires positive evidence before attributing a file to another session", () => {
    const ownership = classifySessionFileOwnership({
      cwd: "/repo",
      gitRoot: "/repo",
      files: ["src/mine.ts", "src/theirs.ts", "src/unknown.ts"],
      ownEdits: [{ file_path: "src/mine.ts", updated_at: 20 }],
      otherEdits: [{ file_path: "src/theirs.ts", updated_at: 30 }],
    })

    expect(ownership).toEqual({
      editedByUs: ["src/mine.ts"],
      editedByOthers: ["src/theirs.ts"],
      unattributed: ["src/unknown.ts"],
    })
  })

  test("uses the latest positive edit when both sessions touched a file", () => {
    expect(
      classifySessionFileOwnership({
        cwd: "/repo",
        gitRoot: "/repo",
        files: ["src/shared.ts"],
        ownEdits: [{ file_path: "src/shared.ts", updated_at: 40 }],
        otherEdits: [{ file_path: "src/shared.ts", updated_at: 30 }],
      }).editedByUs
    ).toEqual(["src/shared.ts"])

    expect(
      classifySessionFileOwnership({
        cwd: "/repo",
        gitRoot: "/repo",
        files: ["src/shared.ts"],
        ownEdits: [{ file_path: "src/shared.ts", updated_at: 20 }],
        otherEdits: [{ file_path: "src/shared.ts", updated_at: 30 }],
      }).editedByOthers
    ).toEqual(["src/shared.ts"])
  })

  test("adds reassurance only for a confirmed other-session edit", () => {
    const unknownContext = appendSessionFileOwnershipContext("On branch main.", {
      editedByUs: [],
      editedByOthers: [],
      unattributed: ["src/unknown.ts"],
    })
    expect(unknownContext).toContain("not evidence of another agent")
    expect(unknownContext).not.toContain("Don't panic.")

    const concurrentContext = appendSessionFileOwnershipContext("On branch main.", {
      editedByUs: [],
      editedByOthers: ["src/theirs.ts"],
      unattributed: [],
    })
    expect(concurrentContext).toContain("Edited by another active session (confirmed):")
    expect(concurrentContext).toContain("Don't panic.")
  })
})
