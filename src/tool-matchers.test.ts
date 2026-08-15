import { describe, expect, test } from "bun:test"
import { isMarkdownOnlyFileReadPayload, isSkillMdOnlyFileEditPayload } from "./tool-matchers.ts"

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

describe("isMarkdownOnlyFileReadPayload", () => {
  test("accepts markdown read targets across supported input shapes", () => {
    expect(
      isMarkdownOnlyFileReadPayload("Read", {
        tool_input: { file_path: "/repo/README.md" },
      })
    ).toBeTrue()
    expect(
      isMarkdownOnlyFileReadPayload("read_file", {
        toolInput: { filePath: "/repo/docs/GUIDE.MD" },
      })
    ).toBeTrue()
    expect(
      isMarkdownOnlyFileReadPayload("read_file", {
        tool_input: { path: "/repo/CHANGELOG.md" },
      })
    ).toBeTrue()
    expect(
      isMarkdownOnlyFileReadPayload("read_many_files", {
        tool_input: { paths: ["/repo/README.md", "/repo/docs/guide.md"] },
      })
    ).toBeTrue()
  })

  test("rejects non-read tools, missing targets, and mixed file types", () => {
    expect(
      isMarkdownOnlyFileReadPayload("Edit", {
        tool_input: { file_path: "/repo/README.md" },
      })
    ).toBeFalse()
    expect(isMarkdownOnlyFileReadPayload("Read", { tool_input: {} })).toBeFalse()
    expect(
      isMarkdownOnlyFileReadPayload("Read", {
        tool_input: { file_path: "/repo/src/main.ts" },
      })
    ).toBeFalse()
    expect(
      isMarkdownOnlyFileReadPayload("read_many_files", {
        tool_input: { paths: ["/repo/README.md", "/repo/src/main.ts"] },
      })
    ).toBeFalse()
  })
})
