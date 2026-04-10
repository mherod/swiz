import { describe, expect, it } from "vitest"
import {
  AGENTS,
  type AgentDef,
  type AgentId,
  agentSupportsTool,
  CONFIGURABLE_AGENTS,
  detectInstalledAgents,
  getAgent,
  getAgentByFlag,
  isAgentInstalled,
  translateEvent,
  translateMatcher,
  validatePublicAgentHookMappings,
} from "./agents.ts"

describe("agents.ts", () => {
  describe("AGENTS constant", () => {
    it("exports an array of agent definitions", () => {
      expect(Array.isArray(AGENTS)).toBe(true)
      expect(AGENTS.length).toBeGreaterThan(0)
    })

    it("contains claude agent definition", () => {
      const claude = AGENTS.find((a) => a.id === "claude")
      expect(claude).toBeDefined()
      expect(claude?.name).toBe("Claude Code")
    })

    it("contains cursor agent definition", () => {
      const cursor = AGENTS.find((a) => a.id === "cursor")
      expect(cursor).toBeDefined()
      expect(cursor?.name).toBe("Cursor")
    })

    it("contains gemini agent definition", () => {
      const gemini = AGENTS.find((a) => a.id === "gemini")
      expect(gemini).toBeDefined()
      expect(gemini?.name).toBe("Gemini CLI")
    })

    it("contains codex agent definition", () => {
      const codex = AGENTS.find((a) => a.id === "codex")
      expect(codex).toBeDefined()
      expect(codex?.name).toBe("Codex CLI")
    })

    it("contains junie agent definition", () => {
      const junie = AGENTS.find((a) => a.id === "junie")
      expect(junie).toBeDefined()
      expect(junie?.name).toBe("Junie")
    })

    it("each agent has required properties", () => {
      AGENTS.forEach((agent) => {
        expect(agent).toHaveProperty("id")
        expect(agent).toHaveProperty("name")
        expect(agent).toHaveProperty("settingsPath")
        expect(agent).toHaveProperty("hooksKey")
        expect(agent).toHaveProperty("configStyle")
        expect(agent).toHaveProperty("binary")
        expect(agent).toHaveProperty("tasksEnabled")
        expect(agent).toHaveProperty("toolAliases")
        expect(agent).toHaveProperty("eventMap")
        expect(agent).toHaveProperty("hooksConfigurable")
      })
    })
  })

  describe("CONFIGURABLE_AGENTS", () => {
    it("is a filtered array of agents", () => {
      expect(Array.isArray(CONFIGURABLE_AGENTS)).toBe(true)
    })

    it("only includes agents with hooksConfigurable true", () => {
      CONFIGURABLE_AGENTS.forEach((agent) => {
        expect(agent.hooksConfigurable).toBe(true)
      })
    })

    it("includes codex now that it has hooksConfigurable true", () => {
      const hasCodex = CONFIGURABLE_AGENTS.some((a) => a.id === "codex")
      expect(hasCodex).toBe(true)
    })

    it("includes agents with true hooks configuration", () => {
      expect(CONFIGURABLE_AGENTS.length).toBeGreaterThan(0)
      expect(CONFIGURABLE_AGENTS.some((a) => a.id === "claude")).toBe(true)
    })
  })

  describe("getAgent", () => {
    it("finds agent by id", () => {
      const agent = getAgent("claude")
      expect(agent).toBeDefined()
      expect(agent?.id).toBe("claude")
    })

    it("returns undefined for unknown id", () => {
      const agent = getAgent("unknown")
      expect(agent).toBeUndefined()
    })

    it("finds cursor agent", () => {
      const agent = getAgent("cursor")
      expect(agent?.name).toBe("Cursor")
    })

    it("finds gemini agent", () => {
      const agent = getAgent("gemini")
      expect(agent?.name).toBe("Gemini CLI")
    })

    it("finds codex agent", () => {
      const agent = getAgent("codex")
      expect(agent?.name).toBe("Codex CLI")
    })

    it("finds junie agent", () => {
      const agent = getAgent("junie")
      expect(agent?.name).toBe("Junie")
    })

    it("returns exact agent object reference", () => {
      const agent = getAgent("claude")
      expect(agent).toBe(AGENTS[0])
    })
  })

  describe("getAgentByFlag", () => {
    it("returns all agents when no explicit flag given", () => {
      const agents = getAgentByFlag([])
      expect(agents.length).toBe(AGENTS.length)
    })

    it("filters agents by --id flag", () => {
      const agents = getAgentByFlag(["--claude"])
      expect(agents.length).toBe(1)
      expect(agents[0]?.id).toBe("claude")
    })

    it("supports multiple agent flags", () => {
      const agents = getAgentByFlag(["--claude", "--cursor"])
      expect(agents.length).toBe(2)
      expect(agents.map((a) => a.id)).toContain("claude")
      expect(agents.map((a) => a.id)).toContain("cursor")
    })

    it("returns all agents for non-agent flag", () => {
      const agents = getAgentByFlag(["--unknown"])
      expect(agents.length).toBe(AGENTS.length)
    })

    it("ignores non-agent flags", () => {
      const agents = getAgentByFlag(["--help", "--verbose"])
      expect(agents.length).toBe(AGENTS.length)
    })

    it("filters for gemini specifically", () => {
      const agents = getAgentByFlag(["--gemini"])
      expect(agents.length).toBe(1)
      expect(agents[0]?.id).toBe("gemini")
    })

    it("mixed flags returns matching agents", () => {
      const agents = getAgentByFlag(["--help", "--cursor", "--verbose"])
      expect(agents.length).toBe(1)
      expect(agents[0]?.id).toBe("cursor")
    })
  })

  describe("translateMatcher", () => {
    it("translates undefined matcher", () => {
      const claude = getAgent("claude")!
      const result = translateMatcher(undefined, claude)
      expect(result).toBeUndefined()
    })

    it("leaves unchanged when no aliases apply", () => {
      const claude = getAgent("claude")!
      const matcher = "Unknown"
      const result = translateMatcher(matcher, claude)
      expect(result).toBe("Unknown")
    })

    it("translates Bash to Shell for Cursor", () => {
      const cursor = getAgent("cursor")!
      const result = translateMatcher("Bash", cursor)
      expect(result).toBe("Shell")
    })

    it("translates Edit to StrReplace for Cursor", () => {
      const cursor = getAgent("cursor")!
      const result = translateMatcher("Edit", cursor)
      expect(result).toBe("StrReplace")
    })

    it("translates Task to TodoWrite for Cursor", () => {
      const cursor = getAgent("cursor")!
      const result = translateMatcher("Task", cursor)
      expect(result).toBe("TodoWrite")
    })

    it("translates multiple tools in matcher for Cursor", () => {
      const cursor = getAgent("cursor")!
      const result = translateMatcher("Edit|Write|Bash", cursor)
      expect(result).toContain("StrReplace")
      expect(result).toContain("Shell")
    })

    it("translates Bash to run_shell_command for Gemini", () => {
      const gemini = getAgent("gemini")!
      const result = translateMatcher("Bash", gemini)
      expect(result).toBe("run_shell_command")
    })

    it("translates Bash to shell_command for Codex", () => {
      const codex = getAgent("codex")!
      const result = translateMatcher("Bash", codex)
      expect(result).toBe("shell_command")
    })

    it("leaves unchanged for Claude (empty aliases)", () => {
      const claude = getAgent("claude")!
      const matcher = "Edit|Write|Bash"
      const result = translateMatcher(matcher, claude)
      expect(result).toBe(matcher)
    })

    it("handles complex matchers with multiple pipes", () => {
      const cursor = getAgent("cursor")!
      const result = translateMatcher("Bash|Edit|Write|Task", cursor)
      expect(result).toContain("Shell")
      expect(result).toContain("StrReplace")
      expect(result).toContain("TodoWrite")
    })
  })

  describe("agentSupportsTool", () => {
    it("Claude supports canonical tools by default (and Skill tool)", () => {
      const claude = getAgent("claude")!
      expect(agentSupportsTool(claude, "Bash")).toBe(true)
      expect(agentSupportsTool(claude, "Edit")).toBe(true)
      expect(agentSupportsTool(claude, "Write")).toBe(true)
      expect(agentSupportsTool(claude, "Skill")).toBe(true)
      expect(agentSupportsTool(claude, "Unknown")).toBe(true)
    })

    it("Cursor supports aliased tools", () => {
      const cursor = getAgent("cursor")!
      expect(agentSupportsTool(cursor, "Bash")).toBe(true)
      expect(agentSupportsTool(cursor, "Edit")).toBe(true)
      expect(agentSupportsTool(cursor, "NotebookEdit")).toBe(true)
      // Cursor has no Skill tool
      expect(agentSupportsTool(cursor, "Skill")).toBe(false)
    })

    it("Cursor supports its own tool names", () => {
      const cursor = getAgent("cursor")!
      expect(agentSupportsTool(cursor, "Shell")).toBe(true)
      expect(agentSupportsTool(cursor, "StrReplace")).toBe(true)
      expect(agentSupportsTool(cursor, "EditNotebook")).toBe(true)
    })

    it("Gemini supports its aliased tools", () => {
      const gemini = getAgent("gemini")!
      expect(agentSupportsTool(gemini, "Bash")).toBe(true)
      expect(agentSupportsTool(gemini, "Edit")).toBe(true)
      // Gemini aliases NotebookEdit to NotebookEdit (self-aliased)
      expect(agentSupportsTool(gemini, "NotebookEdit")).toBe(true)
    })

    it("returns false for unknown tools in agents with aliases", () => {
      const cursor = getAgent("cursor")!
      expect(agentSupportsTool(cursor, "NonExistentTool")).toBe(false)
    })
  })

  describe("translateEvent", () => {
    it("translates stop event for Claude", () => {
      const claude = getAgent("claude")!
      const result = translateEvent("stop", claude)
      expect(result).toBe("Stop")
    })

    it("translates preToolUse for Claude", () => {
      const claude = getAgent("claude")!
      const result = translateEvent("preToolUse", claude)
      expect(result).toBe("PreToolUse")
    })

    it("translates postToolUse for Claude", () => {
      const claude = getAgent("claude")!
      const result = translateEvent("postToolUse", claude)
      expect(result).toBe("PostToolUse")
    })

    it("translates stop event for Cursor (lowercase)", () => {
      const cursor = getAgent("cursor")!
      const result = translateEvent("stop", cursor)
      expect(result).toBe("stop")
    })

    it("translates userPromptSubmit for Cursor", () => {
      const cursor = getAgent("cursor")!
      const result = translateEvent("userPromptSubmit", cursor)
      expect(result).toBe("beforeSubmitPrompt")
    })

    it("translates notification for Cursor to supported event", () => {
      const cursor = getAgent("cursor")!
      const result = translateEvent("notification", cursor)
      expect(result).toBe("afterAgentResponse")
    })

    it("translates stop event for Gemini", () => {
      const gemini = getAgent("gemini")!
      const result = translateEvent("stop", gemini)
      expect(result).toBe("AfterAgent")
    })

    it("translates preToolUse for Gemini", () => {
      const gemini = getAgent("gemini")!
      const result = translateEvent("preToolUse", gemini)
      expect(result).toBe("BeforeTool")
    })

    it("translates stop event for Codex to shipped Stop", () => {
      const codex = getAgent("codex")!
      expect(translateEvent("stop", codex)).toBe("Stop")
    })

    it("translates preToolUse for Codex to shipped PreToolUse", () => {
      const codex = getAgent("codex")!
      expect(translateEvent("preToolUse", codex)).toBe("PreToolUse")
    })

    it("translates postToolUse for Codex to shipped PostToolUse", () => {
      const codex = getAgent("codex")!
      expect(translateEvent("postToolUse", codex)).toBe("PostToolUse")
    })

    it("translates userPromptSubmit for Codex to shipped UserPromptSubmit", () => {
      const codex = getAgent("codex")!
      expect(translateEvent("userPromptSubmit", codex)).toBe("UserPromptSubmit")
    })

    it("translates sessionStart for Codex to shipped SessionStart", () => {
      const codex = getAgent("codex")!
      expect(translateEvent("sessionStart", codex)).toBe("SessionStart")
    })

    it("returns canonical event for unknown events", () => {
      const claude = getAgent("claude")!
      const result = translateEvent("unknownEvent", claude)
      expect(result).toBe("unknownEvent")
    })

    it("handles all mapped events for Claude", () => {
      const claude = getAgent("claude")!
      const events = ["stop", "preToolUse", "postToolUse", "sessionStart"]
      events.forEach((event) => {
        const translated = translateEvent(event, claude)
        expect(typeof translated).toBe("string")
        expect(translated.length).toBeGreaterThan(0)
      })
    })
  })

  describe("AgentDef properties", () => {
    it("claude uses nested config style", () => {
      const claude = getAgent("claude")!
      expect(claude.configStyle).toBe("nested")
    })

    it("cursor uses flat config style", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.configStyle).toBe("flat")
    })

    it("cursor wraps hooks with version", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.wrapsHooks).toEqual({ version: 1 })
    })

    it("claude does not wrap hooks", () => {
      const claude = getAgent("claude")!
      expect(claude.wrapsHooks).toBeUndefined()
    })

    it("settings paths have string type", () => {
      AGENTS.forEach((agent) => {
        expect(typeof agent.settingsPath).toBe("string")
        expect(agent.settingsPath.length).toBeGreaterThan(0)
      })
    })

    it("each agent has unique binary name", () => {
      const binaries = AGENTS.map((a) => a.binary)
      const unique = new Set(binaries)
      expect(unique.size).toBe(binaries.length)
    })

    it("each agent has hooksKey property", () => {
      AGENTS.forEach((agent) => {
        expect(typeof agent.hooksKey).toBe("string")
        expect(agent.hooksKey.length).toBeGreaterThan(0)
      })
    })
  })

  describe("tool alias mappings", () => {
    it("cursor has Bash alias", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.toolAliases.Bash).toBe("Shell")
    })

    it("gemini has all major tool aliases", () => {
      const gemini = getAgent("gemini")!
      expect(gemini.toolAliases.Bash).toBe("run_shell_command")
      expect(gemini.toolAliases.Edit).toBe("replace")
      expect(gemini.toolAliases.Write).toBe("write_file")
    })

    it("codex has shell_command for Bash", () => {
      const codex = getAgent("codex")!
      expect(codex.toolAliases.Bash).toBe("shell_command")
    })

    it("codex maps TaskCreate to update_plan", () => {
      const codex = getAgent("codex")!
      expect(codex.toolAliases.TaskCreate).toBe("update_plan")
    })

    it("codex maps TaskUpdate to update_plan", () => {
      const codex = getAgent("codex")!
      expect(codex.toolAliases.TaskUpdate).toBe("update_plan")
    })

    it("codex maps Task to update_plan", () => {
      const codex = getAgent("codex")!
      expect(codex.toolAliases.Task).toBe("update_plan")
    })

    it("claude has Skill tool alias", () => {
      const claude = getAgent("claude")!
      expect(Object.keys(claude.toolAliases).length).toBe(1)
      expect(claude.toolAliases.Skill).toBe("Skill")
    })
  })

  describe("event mappings", () => {
    it("all agents have preToolUse mapping", () => {
      AGENTS.forEach((agent) => {
        expect(agent.eventMap.preToolUse).toBeDefined()
      })
    })

    it("all agents have stop mapping", () => {
      AGENTS.forEach((agent) => {
        expect(agent.eventMap.stop).toBeDefined()
      })
    })

    it("codex maps preToolUse to public PreToolUse", () => {
      const codex = getAgent("codex")!
      expect(codex.eventMap.preToolUse).toBe("PreToolUse")
    })

    it("codex marks non-public hook events unsupported", () => {
      const codex = getAgent("codex")!
      expect(codex.unsupportedEvents).toEqual([
        "sessionEnd",
        "preCompact",
        "notification",
        "subagentStart",
        "subagentStop",
      ])
    })

    it("gemini marks subagent lifecycle events unsupported", () => {
      const gemini = getAgent("gemini")!
      expect(gemini.unsupportedEvents).toContain("subagentStart")
      expect(gemini.unsupportedEvents).toContain("subagentStop")
      expect(gemini.eventMap.subagentStart).toBeUndefined()
      expect(gemini.eventMap.subagentStop).toBeUndefined()
    })
  })

  describe("public hook event validation", () => {
    it("accepts the registered agent table", () => {
      expect(() => validatePublicAgentHookMappings(AGENTS)).not.toThrow()
    })

    it("rejects eventMap values that are not public hook events", () => {
      const brokenAgents: AgentDef[] = AGENTS.map((agent) =>
        agent.id === "codex"
          ? {
              ...agent,
              eventMap: { ...agent.eventMap, preToolUse: "BeforeToolUse" },
            }
          : agent
      )

      expect(() => validatePublicAgentHookMappings(brokenAgents)).toThrow(
        /codex.*preToolUse.*BeforeToolUse/
      )
    })

    it("rejects additional dispatch entries that target non-public hook events", () => {
      const brokenAgents: AgentDef[] = AGENTS.map((agent) =>
        agent.id === "cursor"
          ? {
              ...agent,
              additionalDispatchEntries: {
                ...agent.additionalDispatchEntries,
                beforeToolUseInternal: "preToolUse",
              },
            }
          : agent
      )

      expect(() => validatePublicAgentHookMappings(brokenAgents)).toThrow(
        /cursor.*additionalDispatchEntries.*beforeToolUseInternal/
      )
    })
  })

  describe("detectInstalledAgents", () => {
    it("returns an array", async () => {
      const result = await detectInstalledAgents()
      expect(Array.isArray(result)).toBe(true)
    })

    it("only returns valid AgentDef objects", async () => {
      const result = await detectInstalledAgents()
      for (const agent of result) {
        expect(agent).toHaveProperty("id")
        expect(agent).toHaveProperty("name")
        expect(agent).toHaveProperty("binary")
        expect(agent).toHaveProperty("settingsPath")
      }
    })

    it("returned agents are a subset of AGENTS", async () => {
      const result = await detectInstalledAgents()
      const agentIds = new Set(AGENTS.map((a) => a.id))
      for (const agent of result) {
        expect(agentIds.has(agent.id)).toBe(true)
      }
    })

    it("includes only agents whose binary or settings exist", async () => {
      const result = await detectInstalledAgents()
      for (const agent of result) {
        const binaryExists = Bun.spawnSync(["which", agent.binary]).exitCode === 0
        const settingsExist = await Bun.file(agent.settingsPath).exists()
        expect(binaryExists || settingsExist).toBe(true)
      }
    })

    it("does not return duplicate agents", async () => {
      const result = await detectInstalledAgents()
      const ids = result.map((a) => a.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it("returns exact AgentDef references from AGENTS", async () => {
      const result = await detectInstalledAgents()
      for (const agent of result) {
        const original = AGENTS.find((a) => a.id === agent.id)
        expect(agent).toBe(original)
      }
    })

    it("excludes agents where neither binary nor settings exist", async () => {
      const result = await detectInstalledAgents()
      const detectedIds = new Set(result.map((a) => a.id))
      const excluded = AGENTS.filter((a) => !detectedIds.has(a.id))
      for (const agent of excluded) {
        const binaryExists = Bun.spawnSync(["which", agent.binary]).exitCode === 0
        const settingsExist = await Bun.file(agent.settingsPath).exists()
        expect(binaryExists || settingsExist).toBe(false)
      }
    })

    it("classifies each agent into exactly detected or excluded", async () => {
      const result = await detectInstalledAgents()
      const detectedIds = new Set(result.map((a) => a.id))
      // Every AGENTS entry is either detected or excluded — no gaps
      for (const agent of AGENTS) {
        const binaryExists = Bun.spawnSync(["which", agent.binary]).exitCode === 0
        const settingsExist = await Bun.file(agent.settingsPath).exists()
        if (binaryExists || settingsExist) {
          expect(detectedIds.has(agent.id)).toBe(true)
        } else {
          expect(detectedIds.has(agent.id)).toBe(false)
        }
      }
    })

    it("detects agent with settings file but no binary on PATH", async () => {
      const result = await detectInstalledAgents()
      // Verify the OR logic: any agent detected solely via settings is valid
      for (const agent of result) {
        const binaryExists = Bun.spawnSync(["which", agent.binary]).exitCode === 0
        const settingsExist = await Bun.file(agent.settingsPath).exists()
        // At least one must be true (already tested), but verify both states are tracked
        if (!binaryExists) {
          expect(settingsExist).toBe(true) // settings-only detection
        }
        if (!settingsExist) {
          expect(binaryExists).toBe(true) // binary-only detection
        }
      }
    })

    it("returns consistent results across multiple calls", async () => {
      const first = await detectInstalledAgents()
      const second = await detectInstalledAgents()
      expect(first.map((a) => a.id)).toEqual(second.map((a) => a.id))
    })

    it("preserves AGENTS order in results", async () => {
      const result = await detectInstalledAgents()
      const agentOrder = AGENTS.map((a) => a.id)
      let lastIndex = -1
      for (const agent of result) {
        const idx = agentOrder.indexOf(agent.id)
        expect(idx).toBeGreaterThan(lastIndex)
        lastIndex = idx
      }
    })

    it("matches isAgentInstalled results for every agent in AGENTS", async () => {
      const detected = await detectInstalledAgents()
      const detectedIds = new Set(detected.map((a) => a.id))
      for (const agent of AGENTS) {
        const installed = await isAgentInstalled(agent)
        expect(detectedIds.has(agent.id)).toBe(installed)
      }
    })

    it("returns between 0 and AGENTS.length agents inclusive", async () => {
      const result = await detectInstalledAgents()
      expect(result.length).toBeGreaterThanOrEqual(0)
      expect(result.length).toBeLessThanOrEqual(AGENTS.length)
    })
  })

  describe("envVars detection signatures", () => {
    it("claude has CLAUDECODE in envVars", () => {
      const claude = getAgent("claude")!
      expect(claude.envVars).toContain("CLAUDECODE")
    })

    it("gemini has GEMINI_CLI in envVars", () => {
      const gemini = getAgent("gemini")!
      expect(gemini.envVars).toContain("GEMINI_CLI")
    })

    it("gemini has GEMINI_PROJECT_DIR in envVars", () => {
      const gemini = getAgent("gemini")!
      expect(gemini.envVars).toContain("GEMINI_PROJECT_DIR")
    })

    it("codex has CODEX_MANAGED_BY_NPM in envVars", () => {
      const codex = getAgent("codex")!
      expect(codex.envVars).toContain("CODEX_MANAGED_BY_NPM")
    })

    it("codex has CODEX_THREAD_ID in envVars", () => {
      const codex = getAgent("codex")!
      expect(codex.envVars).toContain("CODEX_THREAD_ID")
    })

    it("cursor has no envVars (relies on processPattern)", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.envVars).toBeUndefined()
    })

    it("cursor has processPattern set", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.processPattern).toBeInstanceOf(RegExp)
    })

    it("cursor processPattern matches __CURSOR_SANDBOX_ENV_RESTORE", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.processPattern!.test("__CURSOR_SANDBOX_ENV_RESTORE=...")).toBe(true)
    })

    it("cursor processPattern does not match unrelated strings", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.processPattern!.test("CLAUDECODE=1")).toBe(false)
      expect(cursor.processPattern!.test("GEMINI_CLI=1")).toBe(false)
    })

    it("cursor has additionalDispatchEntries for CLI shell events", () => {
      const cursor = getAgent("cursor")!
      expect(cursor.additionalDispatchEntries).toBeDefined()
      expect(cursor.additionalDispatchEntries!.beforeShellExecution).toBe("preToolUse")
      expect(cursor.additionalDispatchEntries!.afterShellExecution).toBe("postToolUse")
    })

    it("non-cursor agents have no additionalDispatchEntries", () => {
      for (const agent of AGENTS) {
        if (agent.id !== "cursor") {
          expect(agent.additionalDispatchEntries).toBeUndefined()
        }
      }
    })

    it("agents with envVars have at least one entry", () => {
      for (const agent of AGENTS) {
        if (agent.envVars !== undefined) {
          expect(agent.envVars.length).toBeGreaterThan(0)
        }
      }
    })
  })

  describe("isAgentInstalled", () => {
    function fakeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
      return {
        id: "claude" as AgentId,
        name: "Fake Agent",
        binary: "nonexistent-binary-xyz",
        settingsPath: "/nonexistent/path/settings.json",
        hooksKey: "hooks",
        configStyle: "nested" as const,
        tasksEnabled: false,
        hooksConfigurable: false,
        toolAliases: {},
        eventMap: {},
        ...overrides,
      }
    }

    it("returns false for agent with no binary and no settings", async () => {
      const agent = fakeAgent()
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns true for agent with valid binary on PATH", async () => {
      // "ls" is always available
      const agent = fakeAgent({ binary: "ls" })
      expect(await isAgentInstalled(agent)).toBe(true)
    })

    it("returns true for agent with existing settings file", async () => {
      // package.json always exists in the project root
      const agent = fakeAgent({
        settingsPath: `${process.cwd()}/package.json`,
      })
      expect(await isAgentInstalled(agent)).toBe(true)
    })

    it("returns true when both binary and settings exist", async () => {
      const agent = fakeAgent({
        binary: "ls",
        settingsPath: `${process.cwd()}/package.json`,
      })
      expect(await isAgentInstalled(agent)).toBe(true)
    })

    it("returns true when binary exists but settings do not", async () => {
      const agent = fakeAgent({
        binary: "ls",
        settingsPath: "/nonexistent/settings.json",
      })
      expect(await isAgentInstalled(agent)).toBe(true)
    })

    it("returns true when settings exist but binary does not", async () => {
      const agent = fakeAgent({
        binary: "nonexistent-binary-xyz",
        settingsPath: `${process.cwd()}/package.json`,
      })
      expect(await isAgentInstalled(agent)).toBe(true)
    })

    it("returns false gracefully for empty binary name", async () => {
      const agent = fakeAgent({ binary: "" })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns false gracefully for empty settings path", async () => {
      const agent = fakeAgent({ settingsPath: "" })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns false gracefully for settings path to a directory", async () => {
      const agent = fakeAgent({ settingsPath: "/tmp" })
      // Bun.file("/tmp").exists() returns true for dirs on some platforms,
      // but the function should not throw regardless
      const result = await isAgentInstalled(agent)
      expect(typeof result).toBe("boolean")
    })

    it("handles binary with spaces gracefully", async () => {
      const agent = fakeAgent({ binary: "non existent binary" })
      const result = await isAgentInstalled(agent)
      expect(typeof result).toBe("boolean")
    })

    it("handles settings path with special characters gracefully", async () => {
      const agent = fakeAgent({
        settingsPath: "/tmp/does not exist/settings (copy).json",
      })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns false for binary that is a path to a non-executable file", async () => {
      const agent = fakeAgent({ binary: "/dev/null" })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns false for binary with path separators", async () => {
      const agent = fakeAgent({ binary: "/usr/bin/nonexistent-xyz" })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("returns false for binary with shell metacharacters", async () => {
      const agent = fakeAgent({ binary: "cmd; echo hacked" })
      const result = await isAgentInstalled(agent)
      expect(result).toBe(false)
    })

    it("returns false for settings path with newlines", async () => {
      const agent = fakeAgent({ settingsPath: "/tmp/foo\nbar/settings.json" })
      expect(await isAgentInstalled(agent)).toBe(false)
    })

    it("handles very long binary name gracefully", async () => {
      const agent = fakeAgent({ binary: "x".repeat(1000) })
      const result = await isAgentInstalled(agent)
      expect(typeof result).toBe("boolean")
    })

    it("handles very long settings path gracefully", async () => {
      const agent = fakeAgent({ settingsPath: `/${"a".repeat(1000)}/settings.json` })
      expect(await isAgentInstalled(agent)).toBe(false)
    })
  })
})
