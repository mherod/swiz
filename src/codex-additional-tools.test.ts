import { describe, expect, test } from "bun:test"
import { AGENTS, agentSupportsTool, CODEX_ADDITIONAL_TOOL_NAMES, getAgent } from "./agents.ts"
import { extractReferencedToolsFromSkillText } from "./skill-utils.ts"
import { convertSkillContent } from "./utils/skill-conversion.ts"

describe("Codex additional tool capabilities", () => {
  test("preserves legacy aliases while recognizing this environment's tools", () => {
    const codex = getAgent("codex")!

    expect(codex.toolAliases.Bash).toBe("shell_command")
    expect(codex.toolAliases.Read).toBe("read_file")
    expect(codex.toolAliases.Grep).toBe("grep_files")
    expect(codex.toolAliases.Glob).toBe("list_dir")

    for (const toolName of [
      "exec_command",
      "apply_patch",
      "update_plan",
      ...CODEX_ADDITIONAL_TOOL_NAMES,
    ]) {
      expect(agentSupportsTool(codex, toolName), toolName).toBe(true)
    }
  })

  test("does not grant Codex-only tools to other agents", () => {
    const cursor = getAgent("cursor")!
    const gemini = getAgent("gemini")!

    expect(agentSupportsTool(cursor, "web.run")).toBe(false)
    expect(agentSupportsTool(cursor, "spawn_agent")).toBe(false)
    expect(agentSupportsTool(gemini, "view_image")).toBe(false)
    expect(agentSupportsTool(gemini, "request_user_input")).toBe(false)
  })

  test("discovers dotted and underscored Codex tool references in skill text", () => {
    const referenced = extractReferencedToolsFromSkillText(
      "Use `web.run`, `view_image`, and request_user_input(...) before `spawn_agent`."
    )

    expect(referenced).toEqual(["request_user_input", "spawn_agent", "view_image", "web.run"])
  })

  test("preserves supported Codex tools in converted allowed-tools frontmatter", () => {
    const claude = getAgent("claude")!
    const codex = getAgent("codex")!
    const source =
      "---\nallowed-tools: exec_command, web.run, view_image, spawn_agent\n---\nUse the listed tools.\n"

    const result = convertSkillContent(source, claude, codex, AGENTS)

    expect(result.content).toContain(
      "allowed-tools: exec_command, web.run, view_image, spawn_agent"
    )
    expect(result.unmapped).toEqual([])
  })
})
