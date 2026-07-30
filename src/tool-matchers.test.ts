import { describe, expect, test } from "bun:test"
import { isSkillMdOnlyFileEditPayload } from "./tool-matchers.ts"

describe("isSkillMdOnlyFileEditPayload", () => {
  test("accepts camelCase inputs and plain apply_patch SKILL.md targets", () => {
    expect(
      isSkillMdOnlyFileEditPayload("Edit", {
        toolInput: { filePath: "/repo/.codex/skills/commit/SKILL.md" },
      })
    ).toBeTrue()
    expect(
      isSkillMdOnlyFileEditPayload("apply_patch", {
        tool_input: {
          command: "*** Begin Patch\n*** Update File: .agents/skills/push/SKILL.md\n*** End Patch",
        },
      })
    ).toBeTrue()
  })

  test("rejects missing and mixed target paths", () => {
    expect(
      isSkillMdOnlyFileEditPayload("apply_patch", { tool_input: { command: "no targets" } })
    ).toBeFalse()
    expect(
      isSkillMdOnlyFileEditPayload("apply_patch", {
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: .codex/skills/commit/SKILL.md",
            "*** Update File: src/main.ts",
            "*** End Patch",
          ].join("\n"),
        },
      })
    ).toBeFalse()
  })
})
