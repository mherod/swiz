import { describe, expect, test } from "bun:test"
import {
  buildWarningInventory,
  ownerForPath,
  stringifyWarningInventory,
} from "./lint-warning-inventory.ts"

describe("lint warning inventory", () => {
  test("assigns representative paths to exclusive child owners", () => {
    expect(ownerForPath("hooks/pretooluse-task-governance.ts")).toEqual({
      issue: 780,
      name: "hook-task",
    })
    expect(ownerForPath("hooks/pretooluse-main-branch-scope-gate.ts")).toEqual({
      issue: 781,
      name: "hook-repository",
    })
    expect(ownerForPath("src/skill-utils.ts")).toEqual({ issue: 793, name: "skill-utils" })
    expect(ownerForPath("src/utils/jsonl.ts")).toEqual({ issue: 795, name: "core-utilities" })
    expect(() => ownerForPath("src/new-warning-source.ts")).toThrow(
      "No warning owner for src/new-warning-source.ts"
    )
  })

  test("groups warnings deterministically by rule, owner, and repository-relative file", () => {
    const results = [
      {
        filePath: "/repo/src/skill-utils.ts",
        messages: [
          { severity: 1, ruleId: "complexity", line: 20, column: 1, message: "complex" },
          { severity: 2, ruleId: "no-error", line: 1, column: 1, message: "ignored error" },
          { severity: 1, ruleId: "max-depth", line: 10, column: 3, message: "deep" },
        ],
      },
    ]

    const inventory = buildWarningInventory(results, "/repo")
    expect(inventory.warningCount).toBe(2)
    expect(inventory.rules).toEqual([
      { ruleId: "complexity", warningCount: 1 },
      { ruleId: "max-depth", warningCount: 1 },
    ])
    expect(inventory.owners.find((owner) => owner.issue === 793)).toMatchObject({
      warningCount: 2,
      files: [{ path: "src/skill-utils.ts", warningCount: 2 }],
    })
    expect(stringifyWarningInventory(inventory)).toBe(stringifyWarningInventory(inventory))
    expect(stringifyWarningInventory(inventory)).not.toContain("/repo/")
  })
})
