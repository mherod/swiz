import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { groupMatches, isDeny, toolMatchesToken } from "../src/dispatch/engine.ts"
import { executeDispatch } from "../src/dispatch/execute.ts"
import { bundledHookManifest, hookIdentifier } from "../src/manifest.ts"
import { evaluatePretooluseBannedCommands } from "./pretooluse-banned-commands.ts"

const browserTools = [
  "mcp__chrome_devtools__list_pages",
  "mcp__chrome_devtools__navigate_page",
  "mcp__chrome_devtools__evaluate_script",
  "mcp__chrome-devtools__take_snapshot",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__puppeteer__puppeteer_navigate",
  "mcp__puppeteer__puppeteer_evaluate",
]

describe("browser MCP tool ban", () => {
  test.each([
    false,
    true,
  ])("dispatch denies browser tools with default MCP skipping (subagent=%s)", async (subagent) => {
    const groups = bundledHookManifest.filter((group) =>
      group.hooks.some((hook) => hookIdentifier(hook) === "pretooluse-banned-commands.ts")
    )
    for (const tool_name of browserTools) {
      const result = await executeDispatch({
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        settingsHomeOverride: join(tmpdir(), `swiz-browser-settings-${crypto.randomUUID()}`),
        payloadStr: JSON.stringify({
          cwd: process.cwd(),
          session_id: `browser-ban-${crypto.randomUUID()}`,
          ...(subagent ? { agent_type: "explorer", agent_id: "browser-test" } : {}),
          tool_name,
          tool_input: {},
        }),
        manifestProvider: () => Promise.resolve(groups),
      })
      expect(isDeny(result.response)).toBe(true)
      expect(JSON.stringify(result.response)).toContain("cua_repl")
    }
  })
  test("keeps MCP family matching scoped to the requested server", () => {
    expect(toolMatchesToken("mcp__chrome_devtools__list_pages", "mcp__chrome_devtools__.*")).toBe(
      true
    )
    expect(toolMatchesToken("mcp__playwright__browser_navigate", "mcp__chrome_devtools__.*")).toBe(
      false
    )
    expect(toolMatchesToken("mcp__playwright_docs__search", "mcp__playwright__.*")).toBe(false)
    expect(toolMatchesToken("mcp__chrome_devtools__", "mcp__chrome_devtools__.*")).toBe(false)
    expect(
      toolMatchesToken("mcp__chrome_devtools__list_pages", "mcp__chrome_devtools__navigate_page")
    ).toBe(false)
  })
  test.each(browserTools)("routes and denies %s", async (tool_name) => {
    const groups = bundledHookManifest.filter(
      (group) => group.event === "preToolUse" && groupMatches(group, tool_name, undefined)
    )
    expect(groups.flatMap((group) => group.hooks.map(hookIdentifier))).toContain(
      "pretooluse-banned-commands.ts"
    )
    expect(await evaluatePretooluseBannedCommands({ tool_name, tool_input: {} })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
  })

  test.each(["exec", "functions.exec"])("denies browser calls inside %s", async (tool_name) => {
    for (const browserTool of browserTools.filter((name) => !name.includes("-"))) {
      for (const field of ["code", "input"]) {
        for (const code of [
          `text(await tools.${browserTool}({}));`,
          `await tools["${browserTool}"]({});`,
          `await Promise.all([tools.${browserTool}({}), tools.exec_command({cmd:"pwd"})]);`,
        ]) {
          expect(
            await evaluatePretooluseBannedCommands({ tool_name, tool_input: { [field]: code } })
          ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
        }
      }
    }
  })

  test.each([
    "mcp__cua_repl__js",
    "mcp__github__search",
    "mcp__playwright_docs__search",
    "mcp__github__playwright",
    "TaskCreate",
    "TaskUpdate",
  ])("allows %s", async (tool_name) => {
    expect(await evaluatePretooluseBannedCommands({ tool_name, tool_input: {} })).toEqual({})
  })

  test.each([
    'text("tools.mcp__chrome_devtools__list_pages({})");',
    "// tools.mcp__playwright__browser_navigate({})\ntext(1);",
    "/* tools.mcp__puppeteer__puppeteer_navigate({}) */ text(1);",
    'await tools.exec_command({cmd:"rg mcp__chrome_devtools__list_pages hooks"});',
    "await tools.mcp__cua_repl__js({code: 'await cua.getState()'});",
  ])("allows unrelated code: %s", async (code) => {
    expect(
      await evaluatePretooluseBannedCommands({ tool_name: "exec", tool_input: { code } })
    ).toEqual({})
  })
})
