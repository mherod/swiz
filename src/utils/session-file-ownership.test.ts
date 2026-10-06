import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionFileClaim } from "../session-file-claims.ts"
import {
  appendSessionFileOwnershipContext,
  classifySessionFileOwnership,
  summarizeFileOwnership,
} from "./session-file-ownership.ts"

describe("project file ownership summary", () => {
  // Real directory: claim identity probes the filesystem for case sensitivity.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swiz-ownership-summary-")))
  const claim = (file: string, session: string): SessionFileClaim => ({
    project_key: "k",
    file_path: join(root, file),
    session_id: session,
    lane: "",
    claimed_at: 0,
    updated_at: 0,
    expires_at: Number.MAX_SAFE_INTEGER,
  })
  const edit = (file: string, session: string, at: number) => ({
    file_path: join(root, file),
    session_id: session,
    updated_at: at,
  })

  test("counts owning sessions, owned and unowned dirty files", () => {
    const summary = summarizeFileOwnership({
      cwd: root,
      gitRoot: root,
      files: ["a.ts", "b.ts", "c.ts", "d.ts"],
      edits: [edit("a.ts", "s1", 10), edit("b.ts", "s2", 10)],
      claims: [claim("c.ts", "s1")],
    })
    expect(summary).toEqual({ sessions: 2, owned: 3, unowned: 1 })
  })

  test("a claim outranks a later edit, and the latest editor wins otherwise", () => {
    const summary = summarizeFileOwnership({
      cwd: root,
      gitRoot: root,
      files: ["a.ts", "b.ts"],
      edits: [edit("a.ts", "editor", 99), edit("b.ts", "old", 1), edit("b.ts", "new", 2)],
      claims: [claim("a.ts", "claimer")],
    })
    expect(summary).toEqual({ sessions: 2, owned: 2, unowned: 0 })
  })

  test("reports everything unowned without evidence", () => {
    expect(
      summarizeFileOwnership({ cwd: root, gitRoot: root, files: ["x.ts"], edits: [], claims: [] })
    ).toEqual({ sessions: 0, owned: 0, unowned: 1 })
  })
})

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
    expect(concurrentContext).toContain("Edited or explicitly held by another session (confirmed):")
    expect(concurrentContext).toContain("Don't panic.")
  })
})
