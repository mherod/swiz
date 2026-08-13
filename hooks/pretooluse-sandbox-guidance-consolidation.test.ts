import { describe, expect, test } from "bun:test"
import { evaluateSandboxGuidanceConsolidation } from "./pretooluse-sandbox-guidance-consolidation.ts"

function decisionOf(output: unknown): string {
  return (
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision ?? ""
  )
}

describe("evaluateSandboxGuidanceConsolidation", () => {
  test("allows canonical edits without duplicated guidance", () => {
    const output = evaluateSandboxGuidanceConsolidation({
      tool_name: "Edit",
      tool_input: {
        file_path: "hooks/example.ts",
        new_string: "const guidance = buildIssueGuidance(repo)",
      },
    })

    expect(decisionOf(output)).toBe("allow")
  })

  test("denies duplicated cross-repository guidance", () => {
    const output = evaluateSandboxGuidanceConsolidation({
      tool_name: "Write",
      tool_input: {
        file_path: "hooks/example.ts",
        new_string: "Please file an issue on the target repo before continuing.",
      },
    })

    expect(decisionOf(output)).toBe("deny")
  })

  test("ignores empty, unrelated-tool, and exempt-file inputs", () => {
    expect(evaluateSandboxGuidanceConsolidation({ tool_name: "Bash", tool_input: {} })).toEqual({})
    expect(evaluateSandboxGuidanceConsolidation({ tool_name: "Edit", tool_input: {} })).toEqual({})
    expect(
      evaluateSandboxGuidanceConsolidation({
        tool_name: "Edit",
        tool_input: {
          file_path: "hooks/stop-auto-continue.ts",
          new_string: "file an issue on the target repo",
        },
      })
    ).toEqual({})
  })
})
