import { describe, expect, it } from "vitest"
import { filterDisabledHooks } from "../dispatch/index.ts"
import { hookIdentifier } from "../manifest.ts"

describe("filterDisabledHooks", () => {
  const makeGroups = (files: string[]) => [
    { event: "stop", hooks: files.map((file) => ({ file })) },
  ]

  it("returns groups unchanged when disabled set is empty", () => {
    const groups = makeGroups(["stop-ship-checklist.ts", "stop-lint-staged.ts"])
    const result = filterDisabledHooks(groups, new Set())
    expect(result).toEqual(groups)
  })

  it("removes a single disabled hook from a group", () => {
    const groups = makeGroups(["stop-ship-checklist.ts", "stop-lint-staged.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-ship-checklist.ts"]))
    expect(result).toHaveLength(1)
    expect(result[0]?.hooks.map((h) => hookIdentifier(h))).toEqual(["stop-lint-staged.ts"])
  })

  it("removes multiple disabled hooks", () => {
    const groups = makeGroups([
      "stop-ship-checklist.ts",
      "stop-lint-staged.ts",
      "stop-git-status.ts",
    ])
    const result = filterDisabledHooks(
      groups,
      new Set(["stop-ship-checklist.ts", "stop-git-status.ts"])
    )
    expect(result[0]?.hooks.map((h) => hookIdentifier(h))).toEqual(["stop-lint-staged.ts"])
  })

  it("drops groups that become empty after filtering", () => {
    const groups = makeGroups(["stop-ship-checklist.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-ship-checklist.ts"]))
    expect(result).toHaveLength(0)
  })

  it("handles multiple groups independently", () => {
    const groups = [
      {
        event: "stop",
        hooks: [{ file: "stop-ship-checklist.ts" }, { file: "stop-git-status.ts" }],
      },
      {
        event: "postToolUse",
        matcher: "Bash",
        hooks: [{ file: "posttooluse-pr-context.ts" }, { file: "posttooluse-git-context.ts" }],
      },
    ]
    const result = filterDisabledHooks(
      groups,
      new Set(["stop-ship-checklist.ts", "posttooluse-pr-context.ts"])
    )
    expect(result).toHaveLength(2)
    expect(result[0]?.hooks.map((h) => hookIdentifier(h))).toEqual(["stop-git-status.ts"])
    expect(result[1]?.hooks.map((h) => hookIdentifier(h))).toEqual(["posttooluse-git-context.ts"])
  })

  it("preserves group matcher when filtering", () => {
    const groups = [
      {
        event: "preToolUse",
        matcher: "Edit|Write",
        hooks: [{ file: "pretooluse-ts-quality.ts" }, { file: "pretooluse-debug-statements.ts" }],
      },
    ]
    const result = filterDisabledHooks(groups, new Set(["pretooluse-ts-quality.ts"]))
    expect(result[0]?.matcher).toBe("Edit|Write")
    expect(result[0]?.hooks.map((h) => hookIdentifier(h))).toEqual([
      "pretooluse-debug-statements.ts",
    ])
  })

  it("is a no-op when disabled file is not in any group", () => {
    const groups = makeGroups(["stop-ship-checklist.ts", "stop-git-status.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-lint-staged.ts"]))
    expect(result).toEqual(groups)
  })

  it("handles user-level + project-level union (all from both lists)", () => {
    const groups = makeGroups([
      "stop-ship-checklist.ts",
      "stop-lint-staged.ts",
      "stop-git-status.ts",
    ])
    // Union of user + project disabled lists
    const userDisabled = ["stop-ship-checklist.ts"]
    const projectDisabled = ["stop-lint-staged.ts"]
    const combinedSet = new Set([...userDisabled, ...projectDisabled])

    const result = filterDisabledHooks(groups, combinedSet)
    expect(result[0]?.hooks.map((h) => hookIdentifier(h))).toEqual(["stop-git-status.ts"])
  })
})
