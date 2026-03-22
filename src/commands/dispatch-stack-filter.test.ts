import { describe, expect, it } from "vitest"
import { filterStackHooks } from "../dispatch/index.ts"

describe("filterStackHooks", () => {
  const makeGroups = (hookDefs: { file: string; stacks?: string[] }[]) => [
    { event: "stop", hooks: hookDefs },
  ]

  it("returns groups unchanged when detectedStacks is empty", () => {
    const groups = makeGroups([
      { file: "stop-lint-staged.ts", stacks: ["bun", "node"] },
      { file: "stop-github-ci.ts" },
    ])
    const result = filterStackHooks(groups, [])
    expect(result).toEqual(groups)
  })

  it("includes hooks with no stacks field regardless of detected stacks", () => {
    const groups = makeGroups([{ file: "stop-git-status.ts" }])
    const result = filterStackHooks(groups, ["go"])
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-git-status.ts"])
  })

  it("includes hook when stacks list contains the detected stack", () => {
    const groups = makeGroups([{ file: "stop-lint-staged.ts", stacks: ["bun", "node"] }])
    const result = filterStackHooks(groups, ["bun"])
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-lint-staged.ts"])
  })

  it("excludes hook when stacks list does not match detected stacks", () => {
    const groups = makeGroups([{ file: "stop-lint-staged.ts", stacks: ["bun", "node"] }])
    const result = filterStackHooks(groups, ["go"])
    expect(result).toHaveLength(0)
  })

  it("drops a group entirely when all its hooks are excluded", () => {
    const groups = makeGroups([
      { file: "stop-lint-staged.ts", stacks: ["bun"] },
      { file: "stop-quality-checks.ts", stacks: ["node"] },
    ])
    const result = filterStackHooks(groups, ["go"])
    expect(result).toHaveLength(0)
  })

  it("keeps hooks without stacks alongside filtered hooks", () => {
    const groups = makeGroups([
      { file: "stop-git-status.ts" },
      { file: "stop-lint-staged.ts", stacks: ["bun", "node"] },
    ])
    const result = filterStackHooks(groups, ["go"])
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-git-status.ts"])
  })

  it("handles multi-stack polyglot project — includes hooks for any matching stack", () => {
    const groups = makeGroups([
      { file: "stop-lint-staged.ts", stacks: ["bun", "node"] },
      { file: "some-go-hook.ts", stacks: ["go"] },
      { file: "stop-git-status.ts" },
    ])
    const result = filterStackHooks(groups, ["go", "node"])
    const files = result[0]?.hooks.map((h) => h.file)
    expect(files).toContain("stop-lint-staged.ts")
    expect(files).toContain("some-go-hook.ts")
    expect(files).toContain("stop-git-status.ts")
  })

  it("handles multiple groups independently", () => {
    const groups = [
      {
        event: "stop",
        hooks: [
          { file: "stop-lint-staged.ts", stacks: ["bun", "node"] },
          { file: "stop-git-status.ts" },
        ],
      },
      {
        event: "preToolUse",
        matcher: "Bash",
        hooks: [
          { file: "pretooluse-no-npm.ts", stacks: ["node"] },
          { file: "pretooluse-banned-commands.ts" },
        ],
      },
    ]
    const result = filterStackHooks(groups, ["go"])
    expect(result).toHaveLength(2)
    expect(result[0]?.hooks.map((h) => h.file)).toEqual(["stop-git-status.ts"])
    expect(result[1]?.hooks.map((h) => h.file)).toEqual(["pretooluse-banned-commands.ts"])
  })
})
