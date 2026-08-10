import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getIssueStore, type IssueStore, resetIssueStore } from "../src/issue-store.ts"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"
import {
  CONCURRENT_EDIT_WINDOW_MS,
  displayPathFor,
  evaluatePretooluseConcurrentSessionEdits,
  formatConcurrentEditContext,
} from "./pretooluse-concurrent-session-edits.ts"

const NOW = 1_700_000_000_000

function seedStore(): IssueStore {
  const dir = join(
    tmpdir(),
    `swiz-concurrent-edits-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  resetIssueStore()
  return getIssueStore(join(dir, "test.db"))
}

function editInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-mine",
    cwd: "/repo",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/shared.ts" },
    ...overrides,
  }
}

function decisionOf(output: unknown): string | undefined {
  const hso = (output as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput
  return hso?.permissionDecision
}

function contextOf(output: unknown): string {
  const hso = (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
  return hso?.additionalContext ?? ""
}

afterEach(() => {
  resetIssueStore()
})

describe("displayPathFor", () => {
  test("relativises paths inside the project", () => {
    expect(displayPathFor("/repo", "/repo/src/shared.ts")).toBe("src/shared.ts")
  })

  test("keeps paths outside the project absolute", () => {
    expect(displayPathFor("/repo", "/elsewhere/shared.ts")).toBe("/elsewhere/shared.ts")
  })
})

describe("formatConcurrentEditContext", () => {
  test("leads with reassurance and gives exact-file instructions", () => {
    const context = formatConcurrentEditContext("src/shared.ts", 6 * 60_000)
    expect(context.startsWith("Concurrent changes in a shared directory are normal.")).toBe(true)
    expect(context).toContain("Don't panic.")
    expect(context).toContain("Continue as you were.")
    expect(context).toContain("Stay focused on your own task.")
    expect(context).toContain("It's going to be fine.")
    expect(context).toContain("6m ago")
    expect(context).toContain("Re-read src/shared.ts immediately before editing")
    expect(context).toContain("Do not stash")
  })
})

describe("evaluatePretooluseConcurrentSessionEdits", () => {
  test("stays quiet when no other session touched the file", async () => {
    const store = seedStore()
    store.recordSessionEdit(projectKeyFromCwd("/repo"), "session-mine", "/repo/src/shared.ts", NOW)

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(output).toEqual({})
  })

  test("allows with context when another session touched the file recently", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/repo"),
      "session-theirs",
      "/repo/src/shared.ts",
      NOW - 6 * 60_000
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(decisionOf(output)).toBe("allow")
    expect(contextOf(output)).toContain("src/shared.ts")
    expect(contextOf(output)).toContain("6m ago")
    expect(contextOf(output)).toContain("Don't panic")
    expect(contextOf(output)).toContain("continue normally")
  })

  test("checks every file in a multi-file apply_patch", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/repo"),
      "session-theirs",
      "/repo/src/second.ts",
      NOW - 60_000
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(
      editInput({
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/first.ts",
            "*** Update File: src/second.ts",
            "*** End Patch",
          ].join("\n"),
        },
      }),
      NOW
    )

    expect(decisionOf(output)).toBe("allow")
    expect(contextOf(output)).toContain("src/second.ts")
  })

  test("stays quiet when the other session's edit predates the window", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/repo"),
      "session-theirs",
      "/repo/src/shared.ts",
      NOW - CONCURRENT_EDIT_WINDOW_MS - 1
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(output).toEqual({})
  })

  test("stays quiet once this session has written the file after them", async () => {
    const store = seedStore()
    const projectKey = projectKeyFromCwd("/repo")
    store.recordSessionEdit(projectKey, "session-theirs", "/repo/src/shared.ts", NOW - 10 * 60_000)
    store.recordSessionEdit(projectKey, "session-mine", "/repo/src/shared.ts", NOW - 60_000)

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(output).toEqual({})
  })

  test("warns again when they touch the file after this session did", async () => {
    const store = seedStore()
    const projectKey = projectKeyFromCwd("/repo")
    store.recordSessionEdit(projectKey, "session-mine", "/repo/src/shared.ts", NOW - 10 * 60_000)
    store.recordSessionEdit(projectKey, "session-theirs", "/repo/src/shared.ts", NOW - 60_000)

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(decisionOf(output)).toBe("allow")
  })

  test("ignores other files edited by the other session", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/repo"),
      "session-theirs",
      "/repo/src/other.ts",
      NOW - 60_000
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(output).toEqual({})
  })

  test("ignores sessions working in a different project", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/other-repo"),
      "session-theirs",
      "/repo/src/shared.ts",
      NOW - 60_000
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(editInput(), NOW)
    expect(output).toEqual({})
  })

  test("ignores non file-edit tools", async () => {
    const store = seedStore()
    store.recordSessionEdit(
      projectKeyFromCwd("/repo"),
      "session-theirs",
      "/repo/src/shared.ts",
      NOW - 60_000
    )

    const output = await evaluatePretooluseConcurrentSessionEdits(
      editInput({ tool_name: "NotebookEdit" }),
      NOW
    )
    expect(output).toEqual({})
  })

  test("stays quiet when the payload has no file path", async () => {
    seedStore()
    const output = await evaluatePretooluseConcurrentSessionEdits(
      editInput({ tool_input: {} }),
      NOW
    )
    expect(output).toEqual({})
  })
})
