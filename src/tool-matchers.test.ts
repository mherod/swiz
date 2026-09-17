import { describe, expect, test } from "bun:test"
import {
  isAnyProviderTaskCreateTool,
  isAnyProviderTaskListTool,
  isAnyProviderTaskUpdateTool,
  isMarkdownOnlyFileReadPayload,
  isSkillMdOnlyFileEditPayload,
  isTaskListTool,
  stripMcpToolNamespace,
} from "./tool-matchers.ts"
import { isNativeTaskToolName } from "./utils/inline-hook-helpers.ts"

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

// ─── MCP-namespaced task-tool detection ──────────────────────────────────────
//
// The canonical-TaskList sync gate in hooks/pretooluse-task-governance.ts both skips on and
// self-heals from these matchers. A session whose only task tools are MCP performs its sync by
// calling `mcp__swiz__TaskList`; if that name stops being recognised, the gate denies the very
// call that satisfies it and "Run TaskList now" becomes an unsatisfiable retry loop (#825).

describe("stripMcpToolNamespace", () => {
  test("strips the server namespace", () => {
    expect(stripMcpToolNamespace("mcp__swiz__TaskList")).toBe("TaskList")
    expect(stripMcpToolNamespace("mcp__swiz__TaskCreate")).toBe("TaskCreate")
  })

  test("handles a server name containing underscores", () => {
    expect(stripMcpToolNamespace("mcp__claude_ai_Claude_Docs__TaskList")).toBe("TaskList")
  })

  test("returns a non-MCP name unchanged", () => {
    expect(stripMcpToolNamespace("TaskList")).toBe("TaskList")
    expect(stripMcpToolNamespace("Bash")).toBe("Bash")
  })
})

describe("any-provider task matchers", () => {
  test("accept the MCP-namespaced names", () => {
    expect(isAnyProviderTaskListTool("mcp__swiz__TaskList")).toBeTrue()
    expect(isAnyProviderTaskCreateTool("mcp__swiz__TaskCreate")).toBeTrue()
    expect(isAnyProviderTaskUpdateTool("mcp__swiz__TaskUpdate")).toBeTrue()
  })

  test("still accept the bare native names", () => {
    expect(isAnyProviderTaskListTool("TaskList")).toBeTrue()
    expect(isAnyProviderTaskCreateTool("TaskCreate")).toBeTrue()
    expect(isAnyProviderTaskUpdateTool("TaskUpdate")).toBeTrue()
  })

  test("do not cross-match a different task verb", () => {
    expect(isAnyProviderTaskListTool("mcp__swiz__TaskCreate")).toBeFalse()
    expect(isAnyProviderTaskCreateTool("mcp__swiz__TaskList")).toBeFalse()
    expect(isAnyProviderTaskUpdateTool("mcp__swiz__TaskList")).toBeFalse()
  })

  test("reject unrelated MCP tools and near-miss names", () => {
    expect(isAnyProviderTaskListTool("mcp__swiz__reply")).toBeFalse()
    expect(isAnyProviderTaskListTool("mcp__swiz__TaskListing")).toBeFalse()
    expect(isAnyProviderTaskListTool("Bash")).toBeFalse()
  })

  test("control: the strict matcher rejects what the any-provider matcher accepts", () => {
    // The split is the whole point — MCP task tools write to a different store, so they are
    // evidence of a sync but must never be read as proof the native tools exist.
    expect(isTaskListTool("mcp__swiz__TaskList")).toBeFalse()
    expect(isNativeTaskToolName("mcp__swiz__TaskList")).toBeFalse()
    expect(isNativeTaskToolName("TaskList")).toBeTrue()
  })
})
