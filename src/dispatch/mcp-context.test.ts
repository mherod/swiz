import { expect, test } from "bun:test"
import { join } from "node:path"
import type { SwizHookOutput } from "../SwizHook.ts"
import { writeProjectState } from "../settings.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { type DispatchRequest, executeDispatch } from "./execute.ts"

const tmp = useTempDir("swiz-mcp-context-")

async function request(toolName: string, output: SwizHookOutput = {}) {
  const cwd = await tmp.create()
  let calls = 0
  const req: DispatchRequest = {
    canonicalEvent: "postToolUse",
    hookEventName: "PostToolUse",
    daemonContext: true,
    settingsHomeOverride: await tmp.create(),
    payloadStr: JSON.stringify({
      cwd,
      session_id: "mcp-context-session",
      tool_name: toolName,
      tool_input: {},
      _agent: "claude",
    }),
    repositoryCapabilityProvider: async () => ({
      canonicalRoot: cwd,
      repoKey: cwd,
      isRepo: true,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    }),
    replayPendingMutations: async () => {},
    manifestProvider: async () => [
      {
        event: "postToolUse",
        hooks: [
          {
            hook: {
              name: "mcp-context-side-effect",
              event: "postToolUse",
              sideEffect: true,
              run() {
                calls++
                return output
              },
            },
          },
        ],
      },
    ],
  }
  return { req, cwd, calls: () => calls }
}

const context: SwizHookOutput = {
  systemMessage: "Task state updated",
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Task state updated" },
}

test.each([
  ["claude", true],
  ["claude", false],
  ["codex", true],
  ["codex", false],
] as const)("MCP context is silent for %s (daemon: %s) while side effects run", async (agent, daemon) => {
  const fixture = await request("mcp__swiz__TaskUpdate", context)
  fixture.req.daemonContext = daemon
  fixture.req.payloadStr = JSON.stringify({ ...JSON.parse(fixture.req.payloadStr), _agent: agent })
  const { response } = await executeDispatch(fixture.req)
  expect(fixture.calls()).toBe(1)
  expect(response.systemMessage).toBeUndefined()
  expect(response.hookSpecificOutput?.additionalContext).toBeUndefined()
  expect(response.hookExecutions).toHaveLength(1)
})

test("native tool context is retained", async () => {
  const fixture = await request("TaskUpdate", context)
  const { response } = await executeDispatch(fixture.req)
  expect(fixture.calls()).toBe(1)
  expect(response.systemMessage).toContain("Task state updated")
})

test("MCP context is silent even when hook execution is enabled", async () => {
  const fixture = await request("mcp__example__query", context)
  await Bun.write(
    join(fixture.req.settingsHomeOverride!, ".swiz", "settings.json"),
    JSON.stringify({ ignoreMcpTools: false })
  )
  const { response } = await executeDispatch(fixture.req)
  expect(fixture.calls()).toBe(1)
  expect(response.systemMessage).toBeUndefined()
  expect(response.hookSpecificOutput?.additionalContext).toBeUndefined()
})

test("MCP blocks retain their explanation", async () => {
  const fixture = await request("mcp__example__query", {
    decision: "block",
    reason: "Required correction",
  })
  const { response } = await executeDispatch(fixture.req)
  expect(response.decision).toBe("block")
  expect(response.reason).toContain("Required correction")
})

test("MCP dispatch with no matching hooks does not emit project context", async () => {
  const fixture = await request("mcp__swiz__TaskUpdate")
  await writeProjectState(fixture.cwd, "reviewing", "peer-session")
  fixture.req.manifestProvider = async () => []
  const { response } = await executeDispatch(fixture.req)
  expect(response.systemMessage).toBeUndefined()
  expect(response.hookSpecificOutput?.additionalContext).toBeUndefined()
})
