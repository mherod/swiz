import { describe, expect, test } from "bun:test"
import {
  AGENT_TOOL_CAPABILITIES_ENV,
  AGENTS,
  agentSupportsTool,
  CODEX_ADDITIONAL_TOOL_NAMES,
  CODEX_BUILT_IN_TOOL_NAMES,
  CODEX_OPTIONAL_TOOL_NAMES,
  getAgent,
  parseAgentToolCapabilityInventory,
  readAgentToolCapabilityInventoryFromEnv,
} from "./agents.ts"
import {
  buildSkillAgentToolEnvironmentFooter,
  extractReferencedToolsFromSkillText,
} from "./skill-utils.ts"
import { convertSkillContent } from "./utils/skill-conversion.ts"

describe("Codex additional tool capabilities", () => {
  test("preserves legacy aliases and only assumes conservative built-ins", () => {
    const codex = getAgent("codex")!

    expect(codex.toolAliases).toEqual({
      Bash: "shell_command",
      exec_command: "exec_command",
      "functions.exec_command": "functions.exec_command",
      Edit: "apply_patch",
      Write: "apply_patch",
      Read: "read_file",
      Grep: "grep_files",
      Glob: "list_dir",
      NotebookEdit: "apply_patch",
      update_plan: "update_plan",
      "functions.update_plan": "functions.update_plan",
    })

    for (const toolName of [
      "exec_command",
      "apply_patch",
      "update_plan",
      ...CODEX_BUILT_IN_TOOL_NAMES,
    ]) {
      expect(agentSupportsTool(codex, toolName), toolName).toBe(true)
    }
    for (const toolName of CODEX_OPTIONAL_TOOL_NAMES) {
      expect(agentSupportsTool(codex, toolName), toolName).toBe(false)
    }
    expect(codex.knownToolNames).toEqual(CODEX_ADDITIONAL_TOOL_NAMES)
  })

  test("supports optional tools only through a matching active inventory", () => {
    const codex = getAgent("codex")!
    const cursor = getAgent("cursor")!
    const inventory = parseAgentToolCapabilityInventory({
      agentId: "codex",
      toolNames: ["web.run", "spawn_agent", "web.run"],
    })!

    expect(inventory.toolNames).toEqual(["web.run", "spawn_agent"])
    expect(agentSupportsTool(codex, "web.run", inventory)).toBe(true)
    expect(agentSupportsTool(codex, "spawn_agent", inventory)).toBe(true)
    expect(agentSupportsTool(codex, "imagegen", inventory)).toBe(false)
    expect(agentSupportsTool(cursor, "web.run", inventory)).toBe(false)
  })

  test("reads validated invocation metadata and rejects malformed inventories", () => {
    const raw = JSON.stringify({ agentId: "codex", toolNames: ["web.run", "mcp.tool"] })

    expect(readAgentToolCapabilityInventoryFromEnv({ [AGENT_TOOL_CAPABILITIES_ENV]: raw })).toEqual(
      { agentId: "codex", toolNames: ["web.run", "mcp.tool"] }
    )
    expect(
      readAgentToolCapabilityInventoryFromEnv({
        [AGENT_TOOL_CAPABILITIES_ENV]: '{"agentId":"codex","toolNames":["bad tool"]}',
      })
    ).toBeNull()
    expect(
      readAgentToolCapabilityInventoryFromEnv({
        [AGENT_TOOL_CAPABILITIES_ENV]: '{"agentId":"unknown","toolNames":[]}',
      })
    ).toBeNull()
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

  test("filters optional Codex tools in a minimal environment", () => {
    const claude = getAgent("claude")!
    const codex = getAgent("codex")!
    const source =
      "---\nallowed-tools: exec_command, web.run, view_image, spawn_agent\n---\nUse the listed tools.\n"

    const result = convertSkillContent(source, claude, codex, AGENTS, null)

    expect(result.content).toContain("allowed-tools: exec_command, view_image")
    expect(result.unmapped).toEqual(["web.run", "spawn_agent"])
  })

  test("preserves confirmed Codex tools in an extended environment", () => {
    const claude = getAgent("claude")!
    const codex = getAgent("codex")!
    const inventory = {
      agentId: "codex" as const,
      toolNames: ["web.run", "spawn_agent"],
    }
    const source =
      "---\nallowed-tools: exec_command, web.run, view_image, spawn_agent\n---\nUse the listed tools.\n"

    const result = convertSkillContent(source, claude, codex, AGENTS, inventory)

    expect(result.content).toContain(
      "allowed-tools: exec_command, web.run, view_image, spawn_agent"
    )
    expect(result.unmapped).toEqual([])
    expect(buildSkillAgentToolEnvironmentFooter(codex, ["web.run"], inventory)).toBeNull()
    expect(buildSkillAgentToolEnvironmentFooter(codex, ["web.run"], null)).toContain("not exposed")
  })
})
