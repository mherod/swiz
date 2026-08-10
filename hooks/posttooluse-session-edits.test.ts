import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getIssueStore, resetIssueStore } from "../src/issue-store.ts"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"
import { evaluatePosttooluseSessionEdits, resolveEditTargets } from "./posttooluse-session-edits.ts"

function seedStore(): void {
  const dir = join(tmpdir(), `swiz-session-edits-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  resetIssueStore()
  getIssueStore(join(dir, "test.db"))
}

afterEach(() => {
  resetIssueStore()
})

describe("posttooluse-session-edits", () => {
  test("extracts every target from a multi-file apply_patch", () => {
    expect(
      resolveEditTargets({
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/one.ts",
            "*** Add File: src/two.ts",
            "*** End Patch",
          ].join("\n"),
        },
      })
    ).toEqual(["src/one.ts", "src/two.ts"])
  })

  test("records every apply_patch target as positive session evidence", async () => {
    seedStore()
    const cwd = "/repo"
    const sessionId = "session-mine"
    await evaluatePosttooluseSessionEdits({
      cwd,
      session_id: sessionId,
      tool_name: "functions.apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/one.ts",
          "*** Add File: src/two.ts",
          "*** End Patch",
        ].join("\n"),
      },
    })

    expect(getIssueStore().listSessionEdits(projectKeyFromCwd(cwd), sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: "/repo/src/one.ts" }),
        expect.objectContaining({ file_path: "/repo/src/two.ts" }),
      ])
    )
  })
})
