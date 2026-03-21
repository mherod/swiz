import { describe, expect, it } from "vitest"
import { filterDisabledHooks } from "./dispatch.ts"

describe("filterDisabledHooks", () => {
  const makeGroups = (files: string[]) => [
    { event: "stop", hooks: files.map((file) => ({ file })) },
  ]

  it("returns groups unchanged when disabled set is empty", () => {
    const groups = makeGroups(["stop-github-ci.ts", "stop-lint-staged.ts"])
    const result = filterDisabledHooks(groups, new Set())
    expect(result).toEqual(groups)
  })

  it("removes a single disabled hook from a group", () => {
    const groups = makeGroups(["stop-github-ci.ts", "stop-lint-staged.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-github-ci.ts"]))
    expect(result).toHaveLength(1)
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-lint-staged.ts"])
  })

  it("removes multiple disabled hooks", () => {
    const groups = makeGroups(["stop-github-ci.ts", "stop-lint-staged.ts", "stop-git-status.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-github-ci.ts", "stop-git-status.ts"]))
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-lint-staged.ts"])
  })

  it("drops groups that become empty after filtering", () => {
    const groups = makeGroups(["stop-github-ci.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-github-ci.ts"]))
    expect(result).toHaveLength(0)
  })

  it("handles multiple groups independently", () => {
    const groups = [
      { event: "stop", hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-git-status.ts" }] },
      {
        event: "postToolUse",
        matcher: "Bash",
        hooks: [{ file: "posttooluse-pr-context.ts" }, { file: "posttooluse-git-status.ts" }],
      },
    ]
    const result = filterDisabledHooks(
      groups,
      new Set(["stop-github-ci.ts", "posttooluse-pr-context.ts"])
    )
    expect(result).toHaveLength(2)
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-git-status.ts"])
    expect(result[1]?.hooks.map((h) => h.file)).toEqual(["posttooluse-git-status.ts"])
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
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["pretooluse-debug-statements.ts"])
  })

  it("is a no-op when disabled file is not in any group", () => {
    const groups = makeGroups(["stop-github-ci.ts", "stop-git-status.ts"])
    const result = filterDisabledHooks(groups, new Set(["stop-lint-staged.ts"]))
    expect(result).toEqual(groups)
  })

  it("handles user-level + project-level union (all from both lists)", () => {
    const groups = makeGroups(["stop-github-ci.ts", "stop-lint-staged.ts", "stop-git-status.ts"])
    // Union of user + project disabled lists
    const userDisabled = ["stop-github-ci.ts"]
    const projectDisabled = ["stop-lint-staged.ts"]
    const combinedSet = new Set([...userDisabled, ...projectDisabled])

    const result = filterDisabledHooks(groups, combinedSet)
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-git-status.ts"])
  })
})
